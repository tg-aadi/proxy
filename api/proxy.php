<?php
header("Access-Control-Allow-Origin: *");

$url = $_GET['url'] ?? '';
if (!$url || !filter_var($url, FILTER_VALIDATE_URL)) {
    http_response_code(400);
    exit("❌ Invalid URL");
}

$headers = [
    "User-Agent: OTT Player/1.7.3.1 (Linux;Android 13; 1i0xmj0) ExoPlayerLib/2.15.1",
    "Referer: http://localhost/",
    "Origin: http://localhost/",
    "Accept-Encoding: identity"
];

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, false);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_USERAGENT, $headers[0]);

$data = curl_exec($ch);
$contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: "application/octet-stream";
curl_close($ch);

header("Content-Type: $contentType");
echo $data;
