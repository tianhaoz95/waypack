import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

import '../models/manifest.dart';
import '../services/api.dart';
import '../services/trip_store.dart';
import '../state/app_state.dart';
import '../util/format.dart';

class PdfExportService {
  static Future<Manifest?> loadManifest(TripEntry entry, TripStore store, Api api) async {
    if (entry.local != null) {
      final f = File('${store.versionDir(entry.id, entry.local!.version).path}/manifest.json');
      if (f.existsSync()) {
        try {
          final data = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
          return Manifest(data);
        } catch (_) {}
      }
    }
    if (entry.remote != null) {
      try {
        final info = await api.downloadInfo(entry.id);
        final m = info.raw['manifest'];
        if (m is Map<String, dynamic>) return Manifest(m);
      } catch (_) {}
    }
    return null;
  }

  static Future<Uint8List> generatePdf({
    required TripEntry entry,
    required Manifest manifest,
    File? coverImageFile,
  }) async {
    final doc = pw.Document(
      title: manifest.title,
      author: 'Waypack',
    );

    final accentHex = manifest.accent ?? '#1D6FE0';
    final accentColor = PdfColor.fromHex(accentHex.startsWith('#') ? accentHex : '#$accentHex');

    pw.MemoryImage? coverImg;
    if (coverImageFile != null && coverImageFile.existsSync()) {
      try {
        coverImg = pw.MemoryImage(await coverImageFile.readAsBytes());
      } catch (_) {}
    }

    final datesStr = dateRange(manifest.startDate, manifest.endDate).replaceAll('\u2013', '-').replaceAll('\u2014', '-');

    doc.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        margin: const pw.EdgeInsets.symmetric(horizontal: 40, vertical: 36),
        header: (pw.Context ctx) {
          if (ctx.pageNumber == 1) return pw.SizedBox();
          return pw.Container(
            margin: const pw.EdgeInsets.only(bottom: 16),
            padding: const pw.EdgeInsets.only(bottom: 6),
            decoration: const pw.BoxDecoration(
              border: pw.Border(bottom: pw.BorderSide(color: PdfColors.grey300, width: 0.5)),
            ),
            child: pw.Row(
              mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
              children: [
                pw.Text(
                  manifest.title,
                  style: const pw.TextStyle(color: PdfColors.grey700, fontSize: 9),
                ),
                pw.Text(
                  datesStr,
                  style: const pw.TextStyle(color: PdfColors.grey600, fontSize: 9),
                ),
              ],
            ),
          );
        },
        footer: (pw.Context ctx) => pw.Container(
          margin: const pw.EdgeInsets.only(top: 16),
          padding: const pw.EdgeInsets.only(top: 6),
          decoration: const pw.BoxDecoration(
            border: pw.Border(top: pw.BorderSide(color: PdfColors.grey300, width: 0.5)),
          ),
          child: pw.Row(
            mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
            children: [
              pw.Text(
                'Waypack Travel Plan · Offline Ready',
                style: const pw.TextStyle(color: PdfColors.grey600, fontSize: 8),
              ),
              pw.Text(
                'Page ${ctx.pageNumber} of ${ctx.pagesCount}',
                style: const pw.TextStyle(color: PdfColors.grey600, fontSize: 8),
              ),
            ],
          ),
        ),
        build: (pw.Context ctx) => [
          // Cover / Header Banner
          if (coverImg != null)
            pw.Container(
              height: 180,
              width: double.infinity,
              margin: const pw.EdgeInsets.only(bottom: 20),
              decoration: pw.BoxDecoration(
                borderRadius: pw.BorderRadius.circular(8),
                image: pw.DecorationImage(image: coverImg, fit: pw.BoxFit.cover),
              ),
            ),

          // Title & Dates
          pw.Container(
            padding: const pw.EdgeInsets.only(bottom: 16),
            decoration: pw.BoxDecoration(
              border: pw.Border(left: pw.BorderSide(color: accentColor, width: 4)),
            ),
            margin: const pw.EdgeInsets.only(bottom: 16),
            child: pw.Padding(
              padding: const pw.EdgeInsets.only(left: 12),
              child: pw.Column(
                crossAxisAlignment: pw.CrossAxisAlignment.start,
                children: [
                  pw.Text(
                    manifest.title,
                    style: pw.TextStyle(
                      fontSize: 24,
                      fontWeight: pw.FontWeight.bold,
                      color: PdfColors.grey900,
                    ),
                  ),
                  pw.SizedBox(height: 6),
                  pw.Text(
                    '$datesStr · ${manifest.timezone}',
                    style: const pw.TextStyle(fontSize: 12, color: PdfColors.grey700),
                  ),
                ],
              ),
            ),
          ),

          // Summary
          if (manifest.summary != null && manifest.summary!.isNotEmpty) ...[
            pw.Container(
              padding: const pw.EdgeInsets.all(12),
              margin: const pw.EdgeInsets.only(bottom: 20),
              decoration: pw.BoxDecoration(
                color: PdfColors.grey100,
                borderRadius: pw.BorderRadius.circular(6),
              ),
              child: pw.Text(
                manifest.summary!,
                style: const pw.TextStyle(fontSize: 10, color: PdfColors.grey800, lineSpacing: 2),
              ),
            ),
          ],

          // Daily Itinerary
          if (manifest.days.isNotEmpty) ...[
            pw.Text(
              'Daily Itinerary',
              style: pw.TextStyle(fontSize: 16, fontWeight: pw.FontWeight.bold, color: accentColor),
            ),
            pw.SizedBox(height: 8),
            ...manifest.days.map((day) {
              return pw.Container(
                margin: const pw.EdgeInsets.only(bottom: 14),
                padding: const pw.EdgeInsets.all(10),
                decoration: pw.BoxDecoration(
                  border: pw.Border.all(color: PdfColors.grey300, width: 0.7),
                  borderRadius: pw.BorderRadius.circular(6),
                ),
                child: pw.Column(
                  crossAxisAlignment: pw.CrossAxisAlignment.start,
                  children: [
                    pw.Row(
                      mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
                      children: [
                        pw.Text(
                          day.date,
                          style: pw.TextStyle(fontWeight: pw.FontWeight.bold, fontSize: 12, color: PdfColors.grey900),
                        ),
                        if (day.title != null)
                          pw.Text(
                            day.title!,
                            style: const pw.TextStyle(fontSize: 11, color: PdfColors.grey700),
                          ),
                      ],
                    ),
                    if (day.items.isNotEmpty) ...[
                      pw.SizedBox(height: 8),
                      pw.Divider(color: PdfColors.grey200, height: 1),
                      pw.SizedBox(height: 6),
                      ...day.items.map((item) {
                        final place = item.placeId != null ? manifest.placesById[item.placeId] : null;
                        return pw.Padding(
                          padding: const pw.EdgeInsets.symmetric(vertical: 3),
                          child: pw.Row(
                            crossAxisAlignment: pw.CrossAxisAlignment.start,
                            children: [
                              pw.SizedBox(
                                width: 50,
                                child: pw.Text(
                                  item.time ?? '—',
                                  style: pw.TextStyle(fontSize: 9, fontWeight: pw.FontWeight.bold, color: PdfColors.grey800),
                                ),
                              ),
                              pw.Expanded(
                                child: pw.Column(
                                  crossAxisAlignment: pw.CrossAxisAlignment.start,
                                  children: [
                                    pw.Text(
                                      item.title,
                                      style: pw.TextStyle(fontSize: 10, fontWeight: pw.FontWeight.bold, color: PdfColors.grey900),
                                    ),
                                    if (place != null)
                                      pw.Text(
                                        place.name + (place.address != null ? ' · ${place.address}' : ''),
                                        style: const pw.TextStyle(fontSize: 8.5, color: PdfColors.grey600),
                                      ),
                                    if (item.notes != null)
                                      pw.Text(
                                        item.notes!,
                                        style: const pw.TextStyle(fontSize: 8.5, color: PdfColors.grey700, fontStyle: pw.FontStyle.italic),
                                      ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        );
                      }),
                    ],
                  ],
                ),
              );
            }),
            pw.SizedBox(height: 12),
          ],

          // Places
          if (manifest.places.isNotEmpty) ...[
            pw.Text(
              'Key Places & Lodging',
              style: pw.TextStyle(fontSize: 16, fontWeight: pw.FontWeight.bold, color: accentColor),
            ),
            pw.SizedBox(height: 8),
            pw.Wrap(
              spacing: 8,
              runSpacing: 8,
              children: manifest.places.map((place) {
                return pw.Container(
                  width: 240,
                  padding: const pw.EdgeInsets.all(8),
                  decoration: pw.BoxDecoration(
                    color: PdfColors.grey50,
                    border: pw.Border.all(color: PdfColors.grey200, width: 0.5),
                    borderRadius: pw.BorderRadius.circular(4),
                  ),
                  child: pw.Column(
                    crossAxisAlignment: pw.CrossAxisAlignment.start,
                    children: [
                      pw.Text(
                        place.name,
                        style: pw.TextStyle(fontWeight: pw.FontWeight.bold, fontSize: 10),
                      ),
                      if (place.address != null)
                        pw.Text(place.address!, style: const pw.TextStyle(fontSize: 8, color: PdfColors.grey600)),
                      if (place.phone != null)
                        pw.Text('Tel: ${place.phone!}', style: const pw.TextStyle(fontSize: 8, color: PdfColors.grey700)),
                      if (place.notes != null)
                        pw.Text(place.notes!, style: const pw.TextStyle(fontSize: 8, color: PdfColors.grey700)),
                    ],
                  ),
                );
              }).toList(),
            ),
            pw.SizedBox(height: 16),
          ],

          // Emergency & Offline Notes
          if (manifest.emergencyNumbers.isNotEmpty) ...[
            pw.Text(
              'Emergency Contacts',
              style: pw.TextStyle(fontSize: 14, fontWeight: pw.FontWeight.bold, color: PdfColors.red800),
            ),
            pw.SizedBox(height: 6),
            ...manifest.emergencyNumbers.map((e) => pw.Padding(
              padding: const pw.EdgeInsets.only(bottom: 2),
              child: pw.Text('${e['label']}: ${e['value']}', style: const pw.TextStyle(fontSize: 9)),
            )),
          ],
        ],
      ),
    );

    return doc.save();
  }

  static String sanitizeFilename(String name) {
    return name
        .replaceAll(RegExp(r'[^a-zA-Z0-9_\- ]'), '')
        .trim()
        .replaceAll(RegExp(r'\s+'), '_');
  }

  static Future<void> shareAsPdf({
    required TripEntry entry,
    required TripStore store,
    required Api api,
  }) async {
    final manifest = await loadManifest(entry, store, api);
    if (manifest == null) {
      throw Exception('Could not load trip details for PDF generation.');
    }
    final cover = entry.coverFile(store);
    final pdfBytes = await generatePdf(
      entry: entry,
      manifest: manifest,
      coverImageFile: cover,
    );
    final filename = '${sanitizeFilename(entry.title)}.pdf';
    await Printing.sharePdf(bytes: pdfBytes, filename: filename);
  }
}
