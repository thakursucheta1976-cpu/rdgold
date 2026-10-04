import 'package:flutter/material.dart';
import 'api.dart';
import 'screens/login.dart';
import 'screens/home.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Api.i.loadSession();
  runApp(const BullionApp());
}

const kGold = Color(0xFFD4AF37);
const kBg = Color(0xFF0F1115);
const kCard = Color(0xFF1A1D24);
const kGreen = Color(0xFF2ECC71);
const kRed = Color(0xFFE74C3C);

class BullionApp extends StatelessWidget {
  const BullionApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'RDgold',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: kBg,
        colorScheme: const ColorScheme.dark(primary: kGold, secondary: kGold, surface: kCard),
        cardColor: kCard,
        appBarTheme: const AppBarTheme(backgroundColor: kBg, foregroundColor: kGold, elevation: 0),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(backgroundColor: kGold, foregroundColor: Colors.black),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true, fillColor: const Color(0xFF23262E),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
        ),
      ),
      home: Api.i.token == null ? const LoginScreen() : const HomeScreen(),
    );
  }
}
