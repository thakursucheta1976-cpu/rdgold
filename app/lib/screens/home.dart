import 'dart:async';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../api.dart';
import '../main.dart';
import 'login.dart';
import 'trade.dart';
import 'orders.dart';
import 'alerts.dart';
import 'bank.dart';

final inr = NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0);

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int tab = 0;
  Map<String, dynamic>? rates;
  Map<String, num> prevBuy = {};
  StreamSubscription? sub;

  @override
  void initState() {
    super.initState();
    _poll();
    sub = Api.i.rateStream().listen((msg) {
      if (msg['type'] == 'rates' && mounted) {
        _update(Map<String, dynamic>.from(msg['data']));
      } else if (msg['type'] == 'alert' && mounted) {
        final d = msg['data'];
        if (d['userId'] == Api.i.user?['id']) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              backgroundColor: kGold,
              content: Text('🔔 ${d['product']} crossed ₹${d['target']} (now ₹${d['rate']})',
                  style: const TextStyle(color: Colors.black))));
        }
      }
    });
  }

  Future<void> _poll() async {
    try {
      await Api.i.me(); // refresh approval status
      _update(await Api.i.rates());
      if (mounted) setState(() {});
    } catch (_) {}
  }

  void _update(Map<String, dynamic> r) {
    if (rates != null) {
      for (final p in (rates!['products'] as List)) {
        if (p['buy'] != null) prevBuy[p['code']] = p['buy'];
      }
    }
    setState(() => rates = r);
  }

  @override
  void dispose() { sub?.cancel(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final pages = <Widget>[_ratesPage(), const OrdersScreen(), const AlertsScreen(), const BankScreen()];
    return Scaffold(
      appBar: AppBar(
        title: Row(children: [
          const Text('RDGOLD', style: TextStyle(fontWeight: FontWeight.bold, letterSpacing: 3)),
          const SizedBox(width: 10),
          if (rates != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                  color: _live ? kGreen.withOpacity(.15) : kRed.withOpacity(.15),
                  borderRadius: BorderRadius.circular(12)),
              child: Text(_live ? '● LIVE' : (rates!['marketOpen'] == false ? '● CLOSED' : '● STALE'),
                  style: TextStyle(fontSize: 11, color: _live ? kGreen : kRed)),
            ),
        ]),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, size: 20),
            onPressed: () async {
              await Api.i.logout();
              if (context.mounted) {
                Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const LoginScreen()));
              }
            },
          ),
        ],
      ),
      body: IndexedStack(index: tab, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (i) => setState(() => tab = i),
        backgroundColor: kCard,
        indicatorColor: kGold.withOpacity(.2),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.show_chart), label: 'Rates'),
          NavigationDestination(icon: Icon(Icons.receipt_long), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.notifications), label: 'Alerts'),
          NavigationDestination(icon: Icon(Icons.account_balance), label: 'Bank'),
        ],
      ),
    );
  }

  bool get _live => rates != null && rates!['stale'] != true && rates!['marketOpen'] == true;

  Widget _ratesPage() {
    if (rates == null) return const Center(child: CircularProgressIndicator(color: kGold));
    final spot = rates!['spot'];
    final products = rates!['products'] as List;
    final pendingApproval = Api.i.user?['status'] == 'pending';
    return RefreshIndicator(
      color: kGold,
      onRefresh: _poll,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          if (pendingApproval)
            Card(color: const Color(0xFF3A3010), child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(children: const [
                Icon(Icons.hourglass_top, color: kGold),
                SizedBox(width: 8),
                Expanded(child: Text('Account pending approval — you can view rates but not trade yet.')),
              ]),
            )),
          Card(child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _spotChip('GOLD \$', spot['xauusd']),
                _spotChip('SILVER \$', spot['xagusd']),
                _spotChip('USD/INR', spot['usdinr']),
              ],
            ),
          )),
          const SizedBox(height: 4),
          ...products.map(_productCard),
          const SizedBox(height: 8),
          Center(child: Text(
            rates!['ts'] != null && rates!['ts'] > 0
                ? 'Updated ${DateFormat('HH:mm:ss').format(DateTime.fromMillisecondsSinceEpoch(rates!['ts']))} · rates ex-GST (${rates!['gstPct']}% GST on purchase)'
                : 'Waiting for rates…',
            style: const TextStyle(color: Colors.white38, fontSize: 11),
          )),
        ],
      ),
    );
  }

  Widget _spotChip(String label, num? v) => Column(children: [
        Text(label, style: const TextStyle(color: Colors.white54, fontSize: 11)),
        Text(v == null ? '—' : v.toStringAsFixed(2),
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      ]);

  Widget _productCard(dynamic p) {
    final buy = p['buy'] as num?;
    final prev = prevBuy[p['code']];
    Color tickColor = Colors.white;
    IconData? tick;
    if (buy != null && prev != null && buy != prev) {
      final up = buy > prev;
      tickColor = up ? kGreen : kRed;
      tick = up ? Icons.arrow_drop_up : Icons.arrow_drop_down;
    }
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(children: [
          Row(children: [
            Icon(p['metal'] == 'gold' ? Icons.circle : Icons.circle_outlined,
                color: p['metal'] == 'gold' ? kGold : Colors.white70, size: 14),
            const SizedBox(width: 8),
            Text(p['name'], style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const Spacer(),
            if (tick != null) Icon(tick, color: tickColor, size: 28),
            Text(buy == null ? '—' : inr.format(buy),
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: tickColor)),
          ]),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(child: _tradeBtn(p, 'buy', 'BUY ${buy == null ? '' : inr.format(buy)}', kGreen)),
            const SizedBox(width: 10),
            Expanded(child: _tradeBtn(p, 'sell', 'SELL ${p['sell'] == null ? '' : inr.format(p['sell'])}', kRed)),
          ]),
        ]),
      ),
    );
  }

  Widget _tradeBtn(dynamic p, String side, String label, Color color) => ElevatedButton(
        style: ElevatedButton.styleFrom(backgroundColor: color.withOpacity(.15), foregroundColor: color),
        onPressed: p['buy'] == null ? null : () async {
          await showModalBottomSheet(
              context: context,
              isScrollControlled: true,
              backgroundColor: kCard,
              builder: (_) => TradeSheet(product: p, side: side));
        },
        child: Text(label, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
      );
}
