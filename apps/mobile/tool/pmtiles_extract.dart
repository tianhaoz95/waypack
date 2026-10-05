// Runs the app's on-device map extractor from the command line, to check it
// against `pmtiles extract` / `pmtiles verify` (services/tiler image):
//
//   dart run tool/pmtiles_extract.dart <planet-url> <minLon,minLat,maxLon,maxLat> <maxzoom> <out.pmtiles>
import 'dart:io';
import 'dart:typed_data';

import 'package:waypack/services/pmtiles.dart';

Future<void> main(List<String> args) async {
  if (args.length != 4) {
    stderr.writeln(
      'usage: <planet-url> <minLon,minLat,maxLon,maxLat> <maxzoom> <out>',
    );
    exit(2);
  }
  final bbox = args[1].split(',').map(double.parse).toList();
  final src = _Counting(HttpRangeSource(args[0]));
  final ex = PmtilesExtractor(src);
  final t0 = DateTime.now();
  final plan = await ex.plan(bbox, int.parse(args[2]));
  final t1 = DateTime.now();
  stdout.writeln(
    'plan: ${plan.tiles} tiles, ${(plan.tileBytes / 1e6).toStringAsFixed(1)} MB, '
    '${src.requests} requests, ${t1.difference(t0).inMilliseconds} ms',
  );
  await ex.write(plan, File(args[3]));
  final t2 = DateTime.now();
  stdout.writeln(
    'wrote ${args[3]}: ${(await File(args[3]).length() / 1e6).toStringAsFixed(1)} MB, '
    '${src.requests} requests total, ${t2.difference(t1).inMilliseconds} ms',
  );
  src.inner.close();
}

class _Counting implements RangeSource {
  _Counting(this.inner);
  final HttpRangeSource inner;
  int requests = 0;
  @override
  Future<Uint8List> read(int offset, int length) {
    requests++;
    return inner.read(offset, length);
  }
}
