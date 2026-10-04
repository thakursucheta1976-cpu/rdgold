import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../api.dart';
import '../main.dart';

class BankScreen extends StatefulWidget {
  const BankScreen({super.key});
  @override
  State<BankScreen> createState() => _BankScreenState();
}

class _BankScreenState extends State<BankScreen> {
  Map<String, dynamic>? bank;
  bool failed = false;

  @override
  void initState() { super.initState(); _load(); }

  void _load() {
    setState(() => failed = false);
    Api.i.bankDetails()
        .then((b) { if (mounted) setState(() => bank = b); })
        .catchError((_) { if (mounted) setState(() => failed = true); });
  }

  Widget row(String label, String? v) {
    if (v == null || v.isEmpty) return const SizedBox.shrink();
    return ListTile(
      dense: true,
      title: Text(label, style: const TextStyle(color: Colors.white54, fontSize: 12)),
      subtitle: Text(v, style: const TextStyle(fontSize: 15, color: Colors.white)),
      trailing: IconButton(
        icon: const Icon(Icons.copy, size: 16, color: kGold),
        onPressed: () {
          Clipboard.setData(ClipboardData(text: v));
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)));
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (failed) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('Could not load bank details', style: TextStyle(color: Colors.white54)),
        TextButton(onPressed: _load, child: const Text('Retry', style: TextStyle(color: kGold))),
      ]));
    }
    if (bank == null) return const Center(child: CircularProgressIndicator(color: kGold));
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        const Padding(
          padding: EdgeInsets.all(8),
          child: Text('Transfer payment via RTGS/NEFT/IMPS to confirm bookings, then share the UTR on WhatsApp.',
              style: TextStyle(color: Colors.white54, fontSize: 13)),
        ),
        Card(child: Column(children: [
          row('Account name', bank!['account_name']),
          row('Account number', bank!['account_no']),
          row('IFSC', bank!['ifsc']),
          row('Bank', bank!['bank']),
          row('Branch', bank!['branch']),
          row('UPI', bank!['upi']),
        ])),
        const SizedBox(height: 8),
        Card(child: Column(children: [
          row('WhatsApp', bank!['whatsapp']),
          row('Phone', bank!['phone']),
        ])),
        const SizedBox(height: 16),
        Center(child: Text('Logged in as ${Api.i.user?['name'] ?? ''} (${Api.i.user?['phone'] ?? ''})',
            style: const TextStyle(color: Colors.white38, fontSize: 12))),
      ],
    );
  }
}
