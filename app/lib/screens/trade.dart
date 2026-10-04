import 'dart:async';
import 'package:flutter/material.dart';
import '../api.dart';
import '../main.dart';
import 'home.dart' show inr;

/// Bottom sheet: qty → locked quote with 30s countdown → confirm, or place a limit order.
class TradeSheet extends StatefulWidget {
  final dynamic product;
  final String side;
  const TradeSheet({super.key, required this.product, required this.side});
  @override
  State<TradeSheet> createState() => _TradeSheetState();
}

class _TradeSheetState extends State<TradeSheet> {
  final qtyCtl = TextEditingController(text: '1');
  final limitCtl = TextEditingController();
  bool limitMode = false;
  Map<String, dynamic>? quote;
  int secondsLeft = 0;
  Timer? timer;
  bool busy = false;
  String? err, done;

  Color get sideColor => widget.side == 'buy' ? kGreen : kRed;

  @override
  void dispose() { timer?.cancel(); super.dispose(); }

  Future<void> getQuote() async {
    setState(() { busy = true; err = null; });
    try {
      final q = await Api.i.quote(widget.product['code'], widget.side, num.parse(qtyCtl.text));
      timer?.cancel();
      // 2s safety buffer: the server clock started the TTL before our response arrived
      setState(() { quote = q; secondsLeft = ((q['ttlMs'] as num) ~/ 1000) - 2; });
      timer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted) return;
        setState(() {
          secondsLeft--;
          if (secondsLeft <= 0) { timer?.cancel(); quote = null; }
        });
      });
    } catch (e) { setState(() => err = e.toString()); }
    finally { if (mounted) setState(() => busy = false); }
  }

  Future<void> confirm() async {
    if (quote == null) return;
    setState(() { busy = true; err = null; });
    try {
      final o = await Api.i.marketOrder(quote!['quoteId'], quote!['quoteId']);
      timer?.cancel();
      setState(() => done = 'Order #${o['id']} ${o['status']} @ ${inr.format(o['rate'])}');
    } catch (e) { setState(() => err = e.toString()); }
    finally { if (mounted) setState(() => busy = false); }
  }

  Future<void> placeLimit() async {
    setState(() { busy = true; err = null; });
    try {
      final o = await Api.i.limitOrder(widget.product['code'], widget.side,
          num.parse(qtyCtl.text), num.parse(limitCtl.text));
      setState(() => done = 'Limit order #${o['id']} placed @ ${inr.format(o['rate'])}');
    } catch (e) { setState(() => err = e.toString()); }
    finally { if (mounted) setState(() => busy = false); }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.product;
    return Padding(
      padding: EdgeInsets.only(
          left: 20, right: 20, top: 20,
          bottom: MediaQuery.of(context).viewInsets.bottom + 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(children: [
            Text('${widget.side.toUpperCase()}  ${p['name']}',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: sideColor)),
            const Spacer(),
            Text('${p['minQty']}–${p['maxQty']} ${p['unit']}',
                style: const TextStyle(color: Colors.white38, fontSize: 12)),
          ]),
          const SizedBox(height: 14),
          if (done != null) ...[
            Icon(Icons.check_circle, color: kGreen, size: 48),
            const SizedBox(height: 8),
            Text(done!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 15)),
            const SizedBox(height: 14),
            ElevatedButton(onPressed: () => Navigator.pop(context), child: const Text('DONE')),
          ] else ...[
            Row(children: [
              Expanded(child: TextField(
                controller: qtyCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(labelText: 'Qty (${p['unit']} units)'),
                onChanged: (_) { timer?.cancel(); setState(() => quote = null); },
              )),
              const SizedBox(width: 10),
              ChoiceChip(
                label: const Text('Limit'),
                selected: limitMode,
                selectedColor: kGold.withOpacity(.3),
                onSelected: (v) => setState(() { limitMode = v; quote = null; timer?.cancel(); }),
              ),
            ]),
            const SizedBox(height: 12),
            if (limitMode) ...[
              TextField(controller: limitCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Limit rate ₹ per unit')),
              const SizedBox(height: 12),
              ElevatedButton(
                style: ElevatedButton.styleFrom(backgroundColor: sideColor),
                onPressed: busy ? null : placeLimit,
                child: Padding(padding: const EdgeInsets.all(12),
                    child: Text(busy ? '...' : 'PLACE LIMIT ORDER',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white))),
              ),
            ] else if (quote == null) ...[
              ElevatedButton(
                onPressed: busy ? null : getQuote,
                child: Padding(padding: const EdgeInsets.all(12),
                    child: Text(busy ? '...' : 'GET LIVE RATE',
                        style: const TextStyle(fontWeight: FontWeight.bold))),
              ),
            ] else ...[
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                    border: Border.all(color: sideColor), borderRadius: BorderRadius.circular(12)),
                child: Column(children: [
                  Text(inr.format(quote!['rate']),
                      style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: sideColor)),
                  Text('per ${p['unit']} unit · locked', style: const TextStyle(color: Colors.white54, fontSize: 12)),
                  const SizedBox(height: 6),
                  if (widget.side == 'buy')
                    Text('Qty ${quote!['qty']} · GST ${quote!['gstPct']}%: ${inr.format(quote!['gstAmount'])} · Total ${inr.format(quote!['total'])}',
                        style: const TextStyle(fontSize: 13)),
                  if (widget.side == 'sell')
                    Text('Qty ${quote!['qty']} · You receive ${inr.format(quote!['total'])}',
                        style: const TextStyle(fontSize: 13)),
                  const SizedBox(height: 8),
                  LinearProgressIndicator(
                      value: secondsLeft / ((quote!['ttlMs'] as num) / 1000),
                      color: sideColor, backgroundColor: Colors.white12),
                  const SizedBox(height: 4),
                  Text('$secondsLeft s to confirm', style: const TextStyle(fontSize: 12, color: Colors.white54)),
                ]),
              ),
              const SizedBox(height: 12),
              ElevatedButton(
                style: ElevatedButton.styleFrom(backgroundColor: sideColor),
                onPressed: busy ? null : confirm,
                child: Padding(padding: const EdgeInsets.all(12),
                    child: Text(busy ? '...' : 'CONFIRM ${widget.side.toUpperCase()}',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white))),
              ),
            ],
            if (err != null)
              Padding(padding: const EdgeInsets.only(top: 10),
                  child: Text(err!, style: const TextStyle(color: kRed), textAlign: TextAlign.center)),
          ],
        ],
      ),
    );
  }
}
