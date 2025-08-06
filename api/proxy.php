<?php
// ========== 🔧 Configuration ==========
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Headers: *");

$url = $_GET['url'] ?? '';
$type = $_GET['type'] ?? '';

if (!$url || !in_array($type, ['ts', 'm3u8'])) {
    http_response_code(400);
    echo "❌ Invalid request. Missing URL or type.";
    exit;
}

$user_agent = $_SERVER['HTTP_X_USER_AGENT'] ?? 'OTT Player/1.7.3.1';
$host = $_SERVER['HTTP_X_HOST'] ?? parse_url($url, PHP_URL_HOST);
$referer = $_SERVER['HTTP_X_REFERER'] ?? 'http://localhost/';

$headers = [
    "User-Agent: $user_agent",
    "Host: $host",
    "Referer: $referer",
    "Origin: $referer",
    "Accept-Encoding: identity"
];

// ========== 🚀 cURL Fetch ==========
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);

$data = curl_exec($ch);
$err = curl_error($ch);
$http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

// ========== 🧾 Output ==========
if ($http_code >= 400 || !$data) {
    http_response_code(502);
    echo "❌ Proxy Fetch Failed: $err";
    exit;
}

$content_type = $type === 'ts' ? 'video/mp2t' : 'application/vnd.apple.mpegurl';
header("Content-Type: $content_type");
header("Cache-Control: no-store");
echo $data;

