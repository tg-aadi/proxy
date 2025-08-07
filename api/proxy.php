<?php

// Security headers
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('X-XSS-Protection: 1; mode=block');

// Enable CORS
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

// Handle OPTIONS preflight requests
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Rate limiting (using session for simplicity; use a database for production)
session_start();
$rateLimitWindow = 15 * 60; // 15 minutes
$maxRequests = 100;

if (!isset($_SESSION['request_count'])) {
    $_SESSION['request_count'] = 0;
    $_SESSION['request_time'] = time();
}

if (time() - $_SESSION['request_time'] > $rateLimitWindow) {
    $_SESSION['request_count'] = 0;
    $_SESSION['request_time'] = time();
}

if ($_SESSION['request_count'] >= $maxRequests) {
    http_response_code(429);
    echo json_encode([
        'error' => 'Rate limit exceeded',
        'message' => 'Too many requests. Please try again later.'
    ]);
    exit;
}

$_SESSION['request_count']++;

// Get target URL from query parameter or path
$targetUrl = isset($_GET['url']) ? $_GET['url'] : null;
if (!$targetUrl && isset($_SERVER['PATH_INFO'])) {
    $targetUrl = ltrim($_SERVER['PATH_INFO'], '/');
}

if (!$targetUrl) {
    http_response_code(400);
    echo json_encode([
        'error' => 'No target URL provided',
        'message' => 'Provide a target URL using ?url= parameter or in the path'
    ]);
    exit;
}

// Validate URL
if (!filter_var($targetUrl, FILTER_VALIDATE_URL)) {
    http_response_code(400);
    echo json_encode([
        'error' => 'Invalid target URL',
        'message' => 'The provided URL is invalid'
    ]);
    exit;
}

// Initialize cURL
$ch = curl_init();

curl_setopt($ch, CURLOPT_URL, $targetUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_HEADER, true);
//curl_setopt($ch, CURLOPT_NOBODY, false);

// Forward request method and data
$method = $_SERVER['REQUEST_METHOD'];
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);

if (in_array($method, ['POST', 'PUT'])) {
    $data = file_get_contents('php://input');
    curl_setopt($ch, CURLOPT_POSTFIELDS, $data);
}

// Forward client headers, excluding identifying ones
$headers = getallheaders();
$filteredHeaders = [];
$excludeHeaders = ['host', 'user-agent', 'x-forwarded-for', 'x-real-ip'];
foreach ($headers as $key => $value) {
    if (!in_array(strtolower($key), $excludeHeaders)) {
        $filteredHeaders[] = "$key: $value";
    }
}
$filteredHeaders[] = 'X-Proxy-Server: PHP-Proxy';
curl_setopt($ch, CURLOPT_HTTPHEADER, $filteredHeaders);

// Execute request
$response = curl_exec($ch);

// Handle cURL errors
if ($response === false) {
    http_response_code(500);
    echo json_encode([
        'error' => 'Proxy error occurred',
        'message' => curl_error($ch)
    ]);
    curl_close($ch);
    exit;
}

// Get response info
$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
$statusCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$headersOut = substr($response, 0, $headerSize);
$body = substr($response, $headerSize);

// Parse and forward CORS headers
$headerLines = explode("\r\n", $headersOut);
$corsHeaders = [
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers'
];
foreach ($headerLines as $line) {
    foreach ($corsHeaders as $corsHeader) {
        if (stripos($line, $corsHeader) === 0) {
            header($line);
        }
    }
}

// Set response status and body
http_response_code($statusCode);
echo $body;

curl_close($ch);

// Simple logging (use a proper logging system in production)
error_log("[$method] $targetUrl - Status: $statusCode");
?>
