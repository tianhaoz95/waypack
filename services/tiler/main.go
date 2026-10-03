// Waypack tiler: a tiny HTTP wrapper around `pmtiles extract` (design §6.4).
//
//	POST /extract {"source": "<planet url>", "bbox": [minLon,minLat,maxLon,maxLat], "maxzoom": 15}
//	  → 200 application/octet-stream (the .pmtiles extract) with Content-Length
//	POST /mirror  {"source": "<planet url>", "dest": "<rclone remote:path>"}   (monthly planet mirror)
//	GET  /healthz
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type extractReq struct {
	Source  string    `json:"source"`
	BBox    []float64 `json:"bbox"`
	MaxZoom int       `json:"maxzoom"`
}

func httpErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, msg)
}

func validSource(s string) bool {
	return strings.HasPrefix(s, "https://") || strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "s3://") || strings.HasPrefix(s, "file://")
}

func extract(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpErr(w, 405, "POST only")
		return
	}
	var req extractReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		httpErr(w, 400, "bad json: "+err.Error())
		return
	}
	if !validSource(req.Source) {
		httpErr(w, 400, "source must be an http(s)/s3/file URL")
		return
	}
	if len(req.BBox) != 4 || req.BBox[0] >= req.BBox[2] || req.BBox[1] >= req.BBox[3] {
		httpErr(w, 400, "bbox must be [minLon,minLat,maxLon,maxLat]")
		return
	}
	if req.MaxZoom < 0 || req.MaxZoom > 15 {
		req.MaxZoom = 15
	}
	dir, err := os.MkdirTemp("", "extract-")
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	defer os.RemoveAll(dir)
	out := filepath.Join(dir, "out.pmtiles")
	bbox := fmt.Sprintf("%g,%g,%g,%g", req.BBox[0], req.BBox[1], req.BBox[2], req.BBox[3])

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Minute)
	defer cancel()
	start := time.Now()
	cmd := exec.CommandContext(ctx, "pmtiles", "extract", req.Source, out, "--bbox="+bbox, "--maxzoom="+strconv.Itoa(req.MaxZoom), "--download-threads=8")
	logs, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("extract failed bbox=%s: %v\n%s", bbox, err, logs)
		httpErr(w, 502, fmt.Sprintf("pmtiles extract failed: %v\n%s", err, tail(string(logs), 1500)))
		return
	}
	f, err := os.Open(out)
	if err != nil {
		httpErr(w, 500, err.Error())
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	log.Printf("extract bbox=%s z%d → %d bytes in %s", bbox, req.MaxZoom, st.Size(), time.Since(start).Round(time.Millisecond))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	_, _ = io.Copy(w, f)
}

type mirrorReq struct {
	Source string `json:"source"`
	Dest   string `json:"dest"`
}

// mirror streams a planet build into R2 via rclone (configured with RCLONE_CONFIG_R2_* env vars).
func mirror(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpErr(w, 405, "POST only")
		return
	}
	if os.Getenv("MIRROR_TOKEN") == "" || r.Header.Get("Authorization") != "Bearer "+os.Getenv("MIRROR_TOKEN") {
		httpErr(w, 401, "unauthorized")
		return
	}
	var req mirrorReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil || !strings.HasPrefix(req.Source, "https://") || req.Dest == "" {
		httpErr(w, 400, "need {source: https URL, dest: remote:path}")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
	go func() {
		defer cancel()
		cmd := exec.CommandContext(ctx, "rclone", "copyurl", req.Source, req.Dest, "--s3-chunk-size=128M", "--s3-upload-concurrency=8")
		out, err := cmd.CombinedOutput()
		log.Printf("mirror %s → %s: err=%v\n%s", req.Source, req.Dest, err, tail(string(out), 2000))
	}()
	w.WriteHeader(202)
	_, _ = io.WriteString(w, "mirror started\n")
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/extract", extract)
	mux.HandleFunc("/mirror", mirror)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok\n") })
	log.Printf("waypack tiler listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
