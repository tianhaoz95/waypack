import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';

/// The "scrapbook" look shared by every screen (design decision 58/59): dotted kraft paper,
/// handwritten (Caveat) titles, polaroids, washi tape and sticky notes.
///
/// Rule of thumb: UI surfaces (cards, sheets, buttons) follow the theme; "objects" stuck onto
/// the page (polaroids, sticky notes, tickets, the QR code) stay light paper in dark mode, so
/// their text is always [Paper.captionInk].
class Paper {
  const Paper({
    required this.bg,
    required this.ink,
    required this.muted,
    required this.card,
    required this.paper,
    required this.accent,
    required this.ok,
    required this.warn,
    required this.err,
    required this.dots,
    required this.line,
  });
  final Color bg, ink, muted, card, paper, accent, ok, warn, err, dots, line;

  static const captionInk = Color(0xFF3D332B);
  static const captionMuted = Color(0xFF8C7D6E);
  static const sticky = Color(0xFFFFF6C9);
  static const stickyPink = Color(0xFFFFE2D8);
  static const lightPaper = Color(0xFFFFFDF8);
  static const tapes = [
    Color(0xFFF2A28B),
    Color(0xFFA9D3C0),
    Color(0xFFF3D27A),
  ];

  static const light = Paper(
    bg: Color(0xFFF3EADB),
    ink: Color(0xFF4A3F35),
    muted: Color(0xFF8C7D6E),
    card: Color(0xFFFFFDF8),
    paper: Color(0xFFFFFDF8),
    accent: Color(0xFFD9694F),
    ok: Color(0xFF4F8A62),
    warn: Color(0xFFB87810),
    err: Color(0xFFC0432B),
    dots: Color(0x29785A3C),
    line: Color(0x29785A3C),
  );
  static const dark = Paper(
    bg: Color(0xFF231D18),
    ink: Color(0xFFEFE4D6),
    muted: Color(0xFFA89888),
    card: Color(0xFF3A312A),
    paper: Color(0xFFEDE4D4),
    accent: Color(0xFFE88468),
    ok: Color(0xFF4F8A62),
    warn: Color(0xFFB87810),
    err: Color(0xFFF08A70),
    dots: Color(0x12FFE6C8),
    line: Color(0x1FFFE6C8),
  );

  static Paper of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

/// Pastel fills for icon chips (the washi colours, lightened).
abstract final class ChipColor {
  static const pink = Color(0xFFF6C3B2);
  static const mint = Color(0xFFC5E3D5);
  static const yellow = Color(0xFFF7E2A6);
  static const blue = Color(0xFFC7D9EE);
  static const lilac = Color(0xFFDCCDEB);
  static const red = Color(0xFFF5B5A6);
}

/// Handwritten Caveat, for titles and captions only.
TextStyle hand(double size, Color color) => TextStyle(
  fontFamily: 'Caveat',
  fontSize: size,
  fontWeight: FontWeight.w700,
  fontVariations: const [FontVariation('wght', 700)],
  height: 1,
  color: color,
);

const paperShadow = [
  BoxShadow(color: Color(0x2E3C2814), blurRadius: 2, offset: Offset(0, 1)),
  BoxShadow(
    color: Color(0x5A3C2814),
    blurRadius: 16,
    spreadRadius: -10,
    offset: Offset(0, 8),
  ),
];

/// App-wide theme so stock widgets (fields, switches, dialogs, snack bars, progress) match.
ThemeData scrapbookTheme(Brightness b) {
  final p = b == Brightness.dark ? Paper.dark : Paper.light;
  final scheme =
      ColorScheme.fromSeed(
        seedColor: const Color(0xFFD9694F),
        brightness: b,
      ).copyWith(
        primary: p.accent,
        onPrimary: Colors.white,
        surface: p.bg,
        onSurface: p.ink,
        onSurfaceVariant: p.muted,
        surfaceContainerHighest: p.card,
        error: p.err,
      );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: p.bg,
    visualDensity: VisualDensity.standard,
    appBarTheme: AppBarTheme(
      backgroundColor: p.bg,
      foregroundColor: p.ink,
      surfaceTintColor: Colors.transparent,
      titleTextStyle: hand(30, p.ink),
    ),
    cardTheme: CardThemeData(
      color: p.card,
      surfaceTintColor: Colors.transparent,
      margin: const EdgeInsets.symmetric(vertical: 6),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 48),
        shape: const StadiumBorder(),
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(48, 48),
        shape: const StadiumBorder(),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: const WidgetStatePropertyAll(Paper.lightPaper),
      trackColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected)
            ? p.ok
            : p.ink.withValues(alpha: .18),
      ),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: p.accent),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.card,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(6),
        borderSide: BorderSide(color: p.line, width: 1.5),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(6),
        borderSide: BorderSide(color: p.line, width: 1.5),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(6),
        borderSide: BorderSide(color: p.accent, width: 2),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: p.card,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      titleTextStyle: hand(30, p.ink),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: p.bg,
      surfaceTintColor: Colors.transparent,
      dragHandleColor: p.ink.withValues(alpha: .25),
    ),
    // Snack bars are small sticky notes.
    snackBarTheme: const SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: Paper.sticky,
      contentTextStyle: TextStyle(
        color: Paper.captionInk,
        fontSize: 14,
        fontWeight: FontWeight.w600,
      ),
      actionTextColor: Color(0xFFB4523A),
      elevation: 3,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(3)),
      ),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: p.card,
      side: BorderSide.none,
      labelStyle: TextStyle(color: p.ink, fontWeight: FontWeight.w600),
    ),
  );
}

/// The dotted kraft-paper background.
class DotsPainter extends CustomPainter {
  const DotsPainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    const step = 14.0;
    for (var y = step / 2; y < size.height; y += step) {
      for (var x = step / 2; x < size.width; x += step) {
        canvas.drawCircle(Offset(x, y), 1.1, paint);
      }
    }
  }

  @override
  bool shouldRepaint(DotsPainter old) => old.color != color;
}

/// Kraft paper behind [child].
class Kraft extends StatelessWidget {
  const Kraft({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return ColoredBox(
      color: p.bg,
      child: CustomPaint(painter: DotsPainter(p.dots), child: child),
    );
  }
}

/// A full screen on kraft paper with the scrapbook header (back button, handwritten title).
class KraftScaffold extends StatelessWidget {
  const KraftScaffold({
    super.key,
    required this.title,
    required this.body,
    this.subtitle,
    this.actions = const [],
    this.maxWidth = 720,
  });
  final String title;
  final String? subtitle;
  final List<Widget> actions;
  final Widget body;
  final double maxWidth;

  @override
  Widget build(BuildContext context) => AnnotatedRegion<SystemUiOverlayStyle>(
    value: Theme.of(context).brightness == Brightness.dark
        ? SystemUiOverlayStyle.light
        : SystemUiOverlayStyle.dark,
    child: Scaffold(
      backgroundColor: Paper.of(context).bg,
      body: Kraft(
        child: SafeArea(
          bottom: false,
          child: Center(
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  PaperNavBar(
                    title: title,
                    subtitle: subtitle,
                    actions: actions,
                  ),
                  Expanded(child: body),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class PaperNavBar extends StatelessWidget {
  const PaperNavBar({
    super.key,
    required this.title,
    this.subtitle,
    this.actions = const [],
  });
  final String title;
  final String? subtitle;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    final canPop = Navigator.of(context).canPop();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 10),
      child: Row(
        children: [
          if (canPop) ...[
            RoundButton(
              tooltip: 'Back',
              icon: Icons.arrow_back_ios_new,
              iconSize: 17,
              onPressed: () => Navigator.maybePop(context),
            ),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: hand(36, p.ink),
                  ),
                ),
                if (subtitle != null && subtitle!.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: p.muted,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          for (final a in actions) ...[const SizedBox(width: 8), a],
        ],
      ),
    );
  }
}

/// A 40pt paper circle, like the home screen's top-bar buttons.
class RoundButton extends StatelessWidget {
  const RoundButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.accent = false,
    this.size = 40,
    this.iconSize = 20,
  });
  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;
  final bool accent;
  final double size, iconSize;

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      icon: Icon(icon, size: iconSize),
      style: IconButton.styleFrom(
        backgroundColor: accent ? p.accent : p.card,
        foregroundColor: accent ? Colors.white : p.ink,
        fixedSize: Size(size, size),
        minimumSize: Size(size, size),
        elevation: 1,
        shadowColor: const Color(0x553C2814),
      ),
    );
  }
}

/// A strip of washi tape.
class TapeStrip extends StatelessWidget {
  const TapeStrip({
    super.key,
    this.color = const Color(0xFFF2A28B),
    this.width = 58,
    this.height = 16,
    this.angle = -4,
  });
  final Color color;
  final double width, height, angle;
  @override
  Widget build(BuildContext context) => Transform.rotate(
    angle: angle * math.pi / 180,
    child: Opacity(
      opacity: .88,
      child: CustomPaint(
        size: Size(width, height),
        painter: TapePainter(color),
      ),
    ),
  );
}

/// Washi tape centred across the top edge of the enclosing [Stack].
class Tape extends StatelessWidget {
  const Tape({super.key, this.index = 0});
  final int index;
  @override
  Widget build(BuildContext context) => Positioned(
    top: -8,
    left: 0,
    right: 0,
    child: Center(
      child: TapeStrip(
        color: Paper.tapes[index % Paper.tapes.length],
        angle: index % 3 == 1 ? 3 : -4,
      ),
    ),
  );
}

class TapePainter extends CustomPainter {
  const TapePainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    canvas.drawRect(rect, Paint()..color = color);
    canvas.save();
    canvas.clipRect(rect);
    final stripe = Paint()
      ..color = Colors.white.withValues(alpha: .35)
      ..strokeWidth = 4;
    for (var x = -size.height; x < size.width + size.height; x += 8) {
      canvas.drawLine(
        Offset(x, size.height),
        Offset(x + size.height, 0),
        stripe,
      );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(TapePainter old) => old.color != color;
}

/// Light paper with a soft shadow, optionally tilted and taped: polaroids, notes, the QR.
class PaperObject extends StatelessWidget {
  const PaperObject({
    super.key,
    required this.child,
    this.color = Paper.lightPaper,
    this.padding = const EdgeInsets.fromLTRB(8, 8, 8, 10),
    this.tilt = 0,
    this.tape,
    this.radius = 3,
  });
  final Widget child;
  final Color color;
  final EdgeInsets padding;

  /// Degrees.
  final double tilt;

  /// Washi tape colour index, or null for none.
  final int? tape;
  final double radius;

  @override
  Widget build(BuildContext context) {
    Widget w = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        boxShadow: paperShadow,
      ),
      child: DefaultTextStyle.merge(
        style: const TextStyle(color: Paper.captionInk),
        child: IconTheme.merge(
          data: const IconThemeData(color: Paper.captionInk),
          child: child,
        ),
      ),
    );
    if (tape != null) {
      w = Stack(
        clipBehavior: Clip.none,
        children: [
          Padding(padding: const EdgeInsets.only(top: 2), child: w),
          Tape(index: tape!),
        ],
      );
    }
    return tilt == 0
        ? w
        : Transform.rotate(angle: tilt * math.pi / 180, child: w);
  }
}

/// A yellow (or pink) sticky note.
class StickyNote extends StatelessWidget {
  const StickyNote({
    super.key,
    required this.child,
    this.color = Paper.sticky,
    this.tilt = -.6,
    this.tape,
    this.padding = const EdgeInsets.fromLTRB(14, 12, 14, 12),
  });
  final Widget child;
  final Color color;
  final double tilt;
  final int? tape;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) => PaperObject(
    color: color,
    tilt: tilt,
    tape: tape,
    radius: 2,
    padding: padding,
    child: child,
  );
}

/// A rubber stamp: bordered caps label, slightly rotated.
class Stamp extends StatelessWidget {
  const Stamp({
    super.key,
    required this.label,
    required this.color,
    this.icon,
    this.angle = -6,
    this.fontSize = 11,
    this.background,
  });
  final String label;
  final Color color;
  final IconData? icon;
  final double angle, fontSize;
  final Color? background;
  @override
  Widget build(BuildContext context) => Transform.rotate(
    angle: angle * math.pi / 180,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: background,
        border: Border.all(color: color, width: 2),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: fontSize + 2, color: color),
            const SizedBox(width: 4),
          ],
          Text(
            label.toUpperCase(),
            style: TextStyle(
              fontSize: fontSize,
              fontWeight: FontWeight.w900,
              letterSpacing: .9,
              color: color,
            ),
          ),
        ],
      ),
    ),
  );
}

/// A theme-coloured card that groups rows; rows are separated by dashed lines.
class PaperCard extends StatelessWidget {
  const PaperCard({
    super.key,
    required this.children,
    this.margin = const EdgeInsets.symmetric(horizontal: 18),
    this.padding = EdgeInsets.zero,
  });
  final List<Widget> children;
  final EdgeInsets margin, padding;

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return Padding(
      padding: margin,
      child: Container(
        padding: padding,
        decoration: BoxDecoration(
          color: p.card,
          borderRadius: BorderRadius.circular(6),
          boxShadow: const [
            BoxShadow(
              color: Color(0x243C2814),
              blurRadius: 2,
              offset: Offset(0, 1),
            ),
            BoxShadow(
              color: Color(0x4D3C2814),
              blurRadius: 18,
              spreadRadius: -14,
              offset: Offset(0, 8),
            ),
          ],
        ),
        child: Material(
          type: MaterialType.transparency,
          borderRadius: BorderRadius.circular(6),
          clipBehavior: Clip.antiAlias,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final (i, c) in children.indexed) ...[
                if (i > 0) DashedDivider(color: p.line),
                c,
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class DashedDivider extends StatelessWidget {
  const DashedDivider({super.key, required this.color, this.indent = 14});
  final Color color;
  final double indent;
  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.symmetric(horizontal: indent),
    child: CustomPaint(
      size: const Size(double.infinity, 1),
      painter: _DashPainter(color, vertical: false),
    ),
  );
}

/// A dashed line, horizontal or vertical, e.g. the walking trail on Today.
class DashedLine extends StatelessWidget {
  const DashedLine({
    super.key,
    required this.color,
    this.vertical = true,
    this.width = 2.5,
  });
  final Color color;
  final bool vertical;
  final double width;
  @override
  Widget build(BuildContext context) => CustomPaint(
    painter: _DashPainter(color, vertical: vertical, width: width),
  );
}

class _DashPainter extends CustomPainter {
  const _DashPainter(this.color, {required this.vertical, this.width = 1});
  final Color color;
  final bool vertical;
  final double width;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = width
      ..strokeCap = StrokeCap.round;
    final len = vertical ? size.height : size.width;
    for (var d = 0.0; d < len; d += 9) {
      final e = math.min(d + 4.5, len);
      canvas.drawLine(
        vertical ? Offset(size.width / 2, d) : Offset(d, 0),
        vertical ? Offset(size.width / 2, e) : Offset(e, 0),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_DashPainter old) =>
      old.color != color || old.vertical != vertical;
}

/// A pastel circle with an icon, the leading element of every row.
class IconChip extends StatelessWidget {
  const IconChip({
    super.key,
    required this.icon,
    this.color = ChipColor.pink,
    this.size = 32,
  });
  final IconData icon;
  final Color color;
  final double size;
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    child: Icon(icon, size: size * .52, color: Paper.captionInk),
  );
}

/// A row in a [PaperCard]: icon chip, title, optional subtitle and trailing widget.
class PaperRow extends StatelessWidget {
  const PaperRow({
    super.key,
    required this.title,
    this.icon,
    this.chip = ChipColor.pink,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.destructive = false,
    this.enabled = true,
    this.chevron = false,
  });
  final String title;
  final IconData? icon;
  final Color chip;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool destructive, enabled, chevron;

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    final fg = destructive ? p.err : p.ink;
    return Opacity(
      opacity: enabled ? 1 : .45,
      child: InkWell(
        onTap: enabled ? onTap : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 52),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                if (icon != null) ...[
                  IconChip(
                    icon: icon!,
                    color: destructive ? ChipColor.red : chip,
                  ),
                  const SizedBox(width: 12),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: fg,
                        ),
                      ),
                      if (subtitle != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            subtitle!,
                            style: TextStyle(
                              fontSize: 12.5,
                              height: 1.35,
                              color: p.muted,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                if (trailing != null) ...[const SizedBox(width: 10), trailing!],
                if (chevron)
                  Icon(Icons.chevron_right, size: 20, color: p.muted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A handwritten section heading.
class SectionTitle extends StatelessWidget {
  const SectionTitle(
    this.text, {
    super.key,
    this.note,
    this.padding = const EdgeInsets.fromLTRB(20, 24, 20, 10),
    this.size = 28,
  });
  final String text;
  final String? note;
  final EdgeInsets padding;
  final double size;
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return Padding(
      padding: padding,
      child: Semantics(
        header: true,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Flexible(child: Text(text, style: hand(size, p.ink))),
            if (note != null) ...[
              const SizedBox(width: 8),
              Text(
                note!,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: p.muted,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

enum PaperButtonKind { primary, secondary, danger }

/// Pill button: coral primary, paper secondary, brick-red danger.
class PaperButton extends StatelessWidget {
  const PaperButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.kind = PaperButtonKind.primary,
    this.expand = false,
    this.small = false,
    this.onPaper = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final PaperButtonKind kind;
  final bool expand, small;

  /// Sits on a light paper object (keeps light colours in dark mode).
  final bool onPaper;

  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    final (bg, fg) = switch (kind) {
      PaperButtonKind.primary => (p.accent, Colors.white),
      PaperButtonKind.danger => (
        onPaper ? Paper.light.err : p.err,
        Colors.white,
      ),
      PaperButtonKind.secondary =>
        onPaper ? (const Color(0xFFF3EADB), Paper.captionInk) : (p.card, p.ink),
    };
    final h = small ? 36.0 : 48.0;
    final child = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null) ...[
          Icon(icon, size: small ? 16 : 18),
          const SizedBox(width: 7),
        ],
        Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
      ],
    );
    return FilledButton(
      onPressed: onPressed,
      style: FilledButton.styleFrom(
        backgroundColor: bg,
        foregroundColor: fg,
        disabledBackgroundColor: bg.withValues(alpha: .5),
        disabledForegroundColor: fg.withValues(alpha: .8),
        minimumSize: Size(expand ? double.infinity : 0, h),
        padding: EdgeInsets.symmetric(horizontal: small ? 14 : 20),
        shape: const StadiumBorder(),
        elevation: kind == PaperButtonKind.secondary ? 1 : 0,
        shadowColor: const Color(0x553C2814),
        textStyle: TextStyle(
          fontSize: small ? 13.5 : 15,
          fontWeight: FontWeight.w700,
        ),
      ),
      child: child,
    );
  }
}

/// Striped progress bar.
class PaperProgress extends StatelessWidget {
  const PaperProgress({super.key, required this.value, this.track});
  final double? value;
  final Color? track;
  @override
  Widget build(BuildContext context) {
    final p = Paper.of(context);
    return ClipRRect(
      borderRadius: BorderRadius.circular(5),
      child: LinearProgressIndicator(
        value: value,
        minHeight: 10,
        color: p.accent,
        backgroundColor: track ?? p.ink.withValues(alpha: .1),
      ),
    );
  }
}

/// A scrapbook bottom sheet: kraft paper with a grab handle.
Future<T?> showPaperSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
}) => showModalBottomSheet<T>(
  context: context,
  isScrollControlled: true,
  backgroundColor: Colors.transparent,
  barrierColor: const Color(0x61281A0C),
  builder: (ctx) {
    final p = Paper.of(ctx);
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(ctx).height * .92,
        maxWidth: 640,
      ),
      child: ClipRRect(
        borderRadius: const BorderRadius.vertical(top: Radius.circular(26)),
        child: Kraft(
          child: SafeArea(
            top: false,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Center(
                    child: Container(
                      width: 38,
                      height: 5,
                      margin: const EdgeInsets.fromLTRB(0, 10, 0, 14),
                      decoration: BoxDecoration(
                        color: p.ink.withValues(alpha: .25),
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ),
                  ),
                  builder(ctx),
                  const SizedBox(height: 12),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  },
);

/// A taped paper note asking to confirm; true when confirmed.
Future<bool> showPaperConfirm(
  BuildContext context, {
  required String title,
  required String message,
  String confirm = 'Delete',
  bool destructive = true,
}) async {
  final ok = await showDialog<bool>(
    context: context,
    barrierColor: const Color(0x61281A0C),
    builder: (d) => Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.symmetric(horizontal: 34),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 380),
        child: PaperObject(
          tilt: -1.2,
          tape: 1,
          padding: const EdgeInsets.fromLTRB(22, 26, 22, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: hand(32, Paper.captionInk)),
              const SizedBox(height: 8),
              Text(message, style: const TextStyle(fontSize: 14, height: 1.5)),
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(
                    child: PaperButton(
                      label: 'Cancel',
                      kind: PaperButtonKind.secondary,
                      onPaper: true,
                      expand: true,
                      onPressed: () => Navigator.pop(d, false),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: PaperButton(
                      label: confirm,
                      kind: destructive
                          ? PaperButtonKind.danger
                          : PaperButtonKind.primary,
                      onPaper: true,
                      expand: true,
                      onPressed: () => Navigator.pop(d, true),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    ),
  );
  return ok == true;
}

/// The trip's theme colour, or a stable fallback from its id.
Color tripAccent(BuildContext context, TripEntry e) {
  final dark = Theme.of(context).brightness == Brightness.dark;
  return _hex(
        dark ? (e.local?.accentDark ?? e.local?.accent) : e.local?.accent,
      ) ??
      fallbackAccent(e.id);
}

Color? _hex(String? hex) {
  if (hex == null || !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(hex)) return null;
  return Color(int.parse('FF${hex.substring(1)}', radix: 16));
}

Color fallbackAccent(String id) {
  const palette = [
    Color(0xFFC2562D),
    Color(0xFF2F7F9E),
    Color(0xFF3F6EA8),
    Color(0xFFD99A2B),
    Color(0xFF8A5BB8),
    Color(0xFF4E7D4F),
    Color(0xFFE0703A),
  ];
  return palette[id.hashCode.abs() % palette.length];
}

/// The trip's cover image, or a drawn landscape in its theme colour.
class TripCover extends StatelessWidget {
  const TripCover({super.key, required this.entry, required this.accent});
  final TripEntry entry;
  final Color accent;
  @override
  Widget build(BuildContext context) {
    final s = context.read<AppState>();
    final scene = CustomPaint(painter: ScenePainter(accent, entry.id.hashCode));
    final file = entry.coverFile(s.store);
    if (file != null) {
      return Image.file(
        file,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => scene,
      );
    }
    final url = entry.coverImageUrl;
    if (url != null && url.isNotEmpty) {
      return Image.network(
        url,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => scene,
      );
    }
    return scene;
  }
}

/// Sky, sun and two rows of hills, tinted by the trip's accent colour.
class ScenePainter extends CustomPainter {
  const ScenePainter(this.accent, this.seed);
  final Color accent;
  final int seed;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final rnd = math.Random(seed);
    final sky1 = Color.lerp(accent, const Color(0xFFFFF4E2), .62)!;
    final sky2 = Color.lerp(accent, const Color(0xFFFFFBF2), .85)!;
    canvas.drawRect(
      Offset.zero & size,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [sky1, sky2],
        ).createShader(Offset.zero & size),
    );
    final sun = Offset(
      w * (.62 + rnd.nextDouble() * .2),
      h * (.22 + rnd.nextDouble() * .12),
    );
    canvas.drawCircle(sun, h * .2, Paint()..color = const Color(0x59FFF3C4));
    canvas.drawCircle(sun, h * .12, Paint()..color = const Color(0xFFFFF3C4));

    Path hills(double base, double amp, double phase) {
      final path = Path()..moveTo(0, h);
      for (var i = 0; i <= 24; i++) {
        final x = w * i / 24;
        final y =
            base +
            math.sin(x / w * math.pi * 2.2 + phase) * amp +
            math.sin(x / w * math.pi * 5.1 + phase * 2) * amp * .35;
        path.lineTo(x, y);
      }
      return path
        ..lineTo(w, h)
        ..close();
    }

    final far = Color.lerp(accent, sky2, .5)!;
    final near = Color.lerp(accent, const Color(0xFF3A2A22), .12)!;
    canvas.drawPath(
      hills(h * .6, h * .1, rnd.nextDouble() * 6),
      Paint()..color = far,
    );
    canvas.drawPath(
      hills(h * .78, h * .07, rnd.nextDouble() * 6),
      Paint()..color = near,
    );
  }

  @override
  bool shouldRepaint(ScenePainter old) =>
      old.accent != accent || old.seed != seed;
}
