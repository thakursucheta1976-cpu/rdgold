import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../api.dart';
import '../main.dart';
import 'home.dart' show inr;

String _localTime(String? utc) {
  if (utc == null) return '';
  try {
    return DateFormat('d MMM, HH:mm').format(DateTime.parse('${utc.replaceFirst(' ', 'T')}Z').toLocal());
  } catch (_) { return utc; }
}

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});
  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  List orders = [];
  Map<String, dynamic>? pos;
  bool loading = true;

  @override
  void initState() { super.initState(); load(); }

  Future<void> load() async {
    try {
      final o = await Api.i.orders();
      final p = await Api.i.position();
      if (mounted) setState(() { orders = o; pos = p; loading = false; });
    } catch (_) { if (mounted) setState(() => loading = false); }
  }

  static const statusColor = {
    'executed': kGreen, 'delivered': kGold, 'pending': Colors.orange,
    'cancelled': Colors.white38, 'rejected': kRed,
  };

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator(color: kGold));
    return RefreshIndicator(
      color: kGold,
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          if (pos != null)
            Card(child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('POSITION', style: TextStyle(color: kGold, fontWeight: FontWeight.bold, fontSize: 12)),
                const SizedBox(height: 8),
                if ((pos!['positions'] as List).isEmpty)
                  const Text('No executed trades yet', style: TextStyle(color: Colors.white54)),
                ...(pos!['positions'] as List).map((p) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(children: [
                    Expanded(child: Text(p['name'] ?? p['code'])),
                    Text('${p['net_qty'] > 0 ? '+' : ''}${p['net_qty']} units  ·  ${inr.format(p['net_value'])}',
                        style: TextStyle(color: p['net_qty'] >= 0 ? kGreen : kRed)),
                  ]),
                )),
                const Divider(color: Colors.white12),
                Row(children: [
                  const Expanded(child: Text('Exposure / Limit', style: TextStyle(color: Colors.white54))),
                  Text('${inr.format(pos!['openExposure'])} / ${inr.format(pos!['marginLimit'])}'),
                ]),
              ]),
            )),
          const SizedBox(height: 6),
          if (orders.isEmpty)
            const Padding(padding: EdgeInsets.all(40),
                child: Center(child: Text('No orders yet', style: TextStyle(color: Colors.white54)))),
          ...orders.map((o) => Card(
            margin: const EdgeInsets.symmetric(vertical: 4),
            child: ListTile(
              dense: true,
              leading: Icon(o['side'] == 'buy' ? Icons.south_west : Icons.north_east,
                  color: o['side'] == 'buy' ? kGreen : kRed),
              title: Text('#${o['id']}  ${o['productName'] ?? o['product']}  ·  ${o['qty']} @ ${o['rate'] == null ? '—' : inr.format(o['rate'])}'),
              subtitle: Text('${o['type']} · ${_localTime(o['createdAt'])}${o['total'] != null ? ' · total ${inr.format(o['total'])}' : ''}',
                  style: const TextStyle(fontSize: 11)),
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                Text(o['status'].toUpperCase(),
                    style: TextStyle(color: statusColor[o['status']] ?? Colors.white, fontSize: 11, fontWeight: FontWeight.bold)),
                if (o['status'] == 'pending')
                  IconButton(icon: const Icon(Icons.close, size: 18, color: kRed),
                      onPressed: () async {
                        try { await Api.i.cancelOrder(o['id']); }
                        catch (e) {
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text(e.toString()), backgroundColor: kRed));
                          }
                        }
                        load();
                      }),
              ]),
            ),
          )),
        ],
      ),
    );
  }
}
