import 'package:flutter/material.dart';
import '../api.dart';
import '../main.dart';
import 'home.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final phone = TextEditingController();
  final name = TextEditingController();
  final pass = TextEditingController();
  final pan = TextEditingController();
  final gst = TextEditingController();
  final city = TextEditingController();
  bool registering = false;
  bool busy = false;
  String? err;

  Future<void> submit() async {
    setState(() { busy = true; err = null; });
    try {
      if (registering) {
        await Api.i.register(phone.text, name.text, pass.text,
            pan: pan.text.isEmpty ? null : pan.text,
            gst: gst.text.isEmpty ? null : gst.text,
            city: city.text.isEmpty ? null : city.text);
      } else {
        await Api.i.login(phone.text, pass.text);
      }
      if (mounted) {
        Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomeScreen()));
      }
    } catch (e) {
      setState(() => err = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 380),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.monetization_on, color: kGold, size: 64),
                const SizedBox(height: 8),
                const Text('RDGOLD', textAlign: TextAlign.center,
                    style: TextStyle(color: kGold, fontSize: 28, fontWeight: FontWeight.bold, letterSpacing: 6)),
                const SizedBox(height: 4),
                Text(registering ? 'Create account' : 'Login to trade',
                    textAlign: TextAlign.center, style: const TextStyle(color: Colors.white54)),
                const SizedBox(height: 24),
                TextField(controller: phone, keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(hintText: 'Mobile number')),
                const SizedBox(height: 10),
                if (registering) ...[
                  TextField(controller: name, decoration: const InputDecoration(hintText: 'Full name / Firm name')),
                  const SizedBox(height: 10),
                  TextField(controller: pan, decoration: const InputDecoration(hintText: 'PAN (optional)')),
                  const SizedBox(height: 10),
                  TextField(controller: gst, decoration: const InputDecoration(hintText: 'GSTIN (optional)')),
                  const SizedBox(height: 10),
                  TextField(controller: city, decoration: const InputDecoration(hintText: 'City (optional)')),
                  const SizedBox(height: 10),
                ],
                TextField(controller: pass, obscureText: true,
                    decoration: const InputDecoration(hintText: 'Password')),
                const SizedBox(height: 16),
                if (err != null)
                  Padding(padding: const EdgeInsets.only(bottom: 8),
                      child: Text(err!, style: const TextStyle(color: kRed), textAlign: TextAlign.center)),
                ElevatedButton(
                  onPressed: busy ? null : submit,
                  child: Padding(padding: const EdgeInsets.all(12),
                      child: Text(busy ? '...' : (registering ? 'REGISTER' : 'LOGIN'),
                          style: const TextStyle(fontWeight: FontWeight.bold))),
                ),
                TextButton(
                  onPressed: () => setState(() => registering = !registering),
                  child: Text(registering ? 'Have an account? Login' : 'New client? Register',
                      style: const TextStyle(color: kGold)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
