import 'package:flutter/material.dart';
import '../api.dart';
import '../main.dart';

class AlertsScreen extends StatefulWidget {
  const AlertsScreen({super.key});
  @override
  State<AlertsScreen> createState() => _AlertsScreenState();
}

class _AlertsScreenState extends State<AlertsScreen> {
  List alerts = [];
  final rateCtl = TextEditingController();
  String product = 'GOLD999';
  String direction = 'above';
  String? err;

  @override
  void initState() { super.initState(); load(); }

  Future<void> load() async {
    try { final a = await Api.i.alerts(); if (mounted) setState(() => alerts = a); } catch (_) {}
  }

  Future<void> add() async {
    setState(() => err = null);
    try {
      await Api.i.addAlert(product, direction, num.parse(rateCtl.text));
      rateCtl.clear();
      load();
    } catch (e) { setState(() => err = e.toString()); }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Card(child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('NEW RATE ALERT', style: TextStyle(color: kGold, fontWeight: FontWeight.bold, fontSize: 12)),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: DropdownButtonFormField<String>(
                value: product,
                items: const [
                  DropdownMenuItem(value: 'GOLD999', child: Text('Gold 999')),
                  DropdownMenuItem(value: 'GOLD995', child: Text('Gold 995')),
                  DropdownMenuItem(value: 'SILVER999', child: Text('Silver 999')),
                ],
                onChanged: (v) => setState(() => product = v!),
              )),
              const SizedBox(width: 8),
              Expanded(child: DropdownButtonFormField<String>(
                value: direction,
                items: const [
                  DropdownMenuItem(value: 'above', child: Text('Goes above')),
                  DropdownMenuItem(value: 'below', child: Text('Falls below')),
                ],
                onChanged: (v) => setState(() => direction = v!),
              )),
            ]),
            const SizedBox(height: 8),
            TextField(controller: rateCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(hintText: 'Target rate ₹')),
            const SizedBox(height: 10),
            ElevatedButton(onPressed: add, child: const Text('SET ALERT', style: TextStyle(fontWeight: FontWeight.bold))),
            if (err != null) Padding(padding: const EdgeInsets.only(top: 8),
                child: Text(err!, style: const TextStyle(color: kRed))),
          ]),
        )),
        const SizedBox(height: 8),
        ...alerts.map((a) => Card(
          margin: const EdgeInsets.symmetric(vertical: 4),
          child: ListTile(
            dense: true,
            leading: Icon(a['triggered'] == 1 ? Icons.notifications_active : Icons.notifications_none,
                color: a['triggered'] == 1 ? kGold : Colors.white54),
            title: Text('${a['product_code']} ${a['direction']} ₹${a['target_rate']}'),
            subtitle: Text(a['triggered'] == 1 ? 'Triggered' : 'Watching…', style: const TextStyle(fontSize: 11)),
            trailing: IconButton(icon: const Icon(Icons.delete_outline, size: 18),
                onPressed: () async {
                  try { await Api.i.deleteAlert(a['id']); } catch (_) {}
                  load();
                }),
          ),
        )),
      ],
    );
  }
}
