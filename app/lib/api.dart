import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Set this to your server. For local emulator testing use 10.0.2.2.
const String kServer = String.fromEnvironment('SERVER', defaultValue: 'http://10.0.2.2:8080');

class Api {
  Api._();
  static final Api i = Api._();

  String? token;
  Map<String, dynamic>? user;

  Future<void> loadSession() async {
    final sp = await SharedPreferences.getInstance();
    token = sp.getString('token');
    final u = sp.getString('user');
    if (u != null) user = jsonDecode(u);
  }

  Future<void> _saveSession() async {
    final sp = await SharedPreferences.getInstance();
    if (token != null) sp.setString('token', token!);
    if (user != null) sp.setString('user', jsonEncode(user));
  }

  Future<void> logout() async {
    token = null;
    user = null;
    final sp = await SharedPreferences.getInstance();
    await sp.remove('token');
    await sp.remove('user');
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Future<dynamic> _req(String method, String path, [Map<String, dynamic>? body]) async {
    final uri = Uri.parse('$kServer/api$path');
    http.Response r;
    switch (method) {
      case 'GET':
        r = await http.get(uri, headers: _headers);
      case 'POST':
        r = await http.post(uri, headers: _headers, body: jsonEncode(body ?? {}));
      case 'DELETE':
        r = await http.delete(uri, headers: _headers);
      default:
        throw 'bad method';
    }
    final j = r.body.isNotEmpty ? jsonDecode(r.body) : {};
    if (r.statusCode >= 400) throw ApiError(j['error'] ?? 'Error ${r.statusCode}');
    return j;
  }

  Future<void> login(String phone, String password) async {
    final j = await _req('POST', '/login', {'phone': phone, 'password': password});
    token = j['token'];
    user = j['user'];
    await _saveSession();
  }

  Future<void> register(String phone, String name, String password, {String? pan, String? gst, String? city}) async {
    final j = await _req('POST', '/register',
        {'phone': phone, 'name': name, 'password': password, 'pan': pan, 'gst': gst, 'city': city});
    token = j['token'];
    user = j['user'];
    await _saveSession();
  }

  Future<Map<String, dynamic>> rates() async => Map<String, dynamic>.from(await _req('GET', '/rates'));
  Future<List> ratesHistory({int hours = 24}) async => await _req('GET', '/rates/history?hours=$hours');
  Future<Map<String, dynamic>> bankDetails() async => Map<String, dynamic>.from(await _req('GET', '/bank-details'));

  Future<Map<String, dynamic>> quote(String productCode, String side, num qty) async =>
      Map<String, dynamic>.from(await _req('POST', '/quote', {'productCode': productCode, 'side': side, 'qty': qty}));

  Future<Map<String, dynamic>> marketOrder(String quoteId, String idemKey) async =>
      Map<String, dynamic>.from(
          await _req('POST', '/orders', {'type': 'market', 'quoteId': quoteId, 'idempotencyKey': idemKey}));

  Future<Map<String, dynamic>> limitOrder(String productCode, String side, num qty, num limitRate) async =>
      Map<String, dynamic>.from(await _req('POST', '/orders', {
        'type': 'limit', 'productCode': productCode, 'side': side, 'qty': qty, 'limitRate': limitRate,
        'idempotencyKey': DateTime.now().microsecondsSinceEpoch.toString(),
      }));

  Future<List> orders() async => await _req('GET', '/orders');
  Future<void> cancelOrder(int id) async => await _req('DELETE', '/orders/$id');
  Future<Map<String, dynamic>> position() async => Map<String, dynamic>.from(await _req('GET', '/position'));

  Future<List> alerts() async => await _req('GET', '/alerts');
  Future<void> addAlert(String productCode, String direction, num targetRate) async =>
      await _req('POST', '/alerts', {'productCode': productCode, 'direction': direction, 'targetRate': targetRate});
  Future<void> deleteAlert(int id) async => await _req('DELETE', '/alerts/$id');

  Future<Map<String, dynamic>> me() async {
    final j = Map<String, dynamic>.from(await _req('GET', '/me'));
    user = j;
    await _saveSession();
    return j;
  }

  /// Live rates stream over WebSocket (authenticated → personalized rates
  /// + targeted alerts), with auto-reconnect and proper socket cleanup.
  Stream<Map<String, dynamic>> rateStream() async* {
    while (true) {
      final wsUrl = kServer.replaceFirst('http', 'ws');
      final q = token != null ? '?token=$token' : '';
      WebSocketChannel? ch;
      try {
        ch = WebSocketChannel.connect(Uri.parse('$wsUrl/ws/rates$q'));
        await ch.ready;
        await for (final msg in ch.stream) {
          final j = jsonDecode(msg as String);
          yield Map<String, dynamic>.from(j);
        }
      } catch (_) {
      } finally {
        try { await ch?.sink.close(); } catch (_) {}
      }
      await Future.delayed(const Duration(seconds: 3));
    }
  }
}

class ApiError implements Exception {
  final String message;
  ApiError(this.message);
  @override
  String toString() => message;
}
