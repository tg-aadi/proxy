<?php
/*
NOTE: This is a modified version of miniProxy for Vercel deployment.
Original miniProxy is NO LONGER MAINTAINED AS OF APRIL 26th, 2020.
IF YOU USE IT, YOU DO SO ENTIRELY AT YOUR OWN RISK.
More information is available at <https://github.com/joshdick/miniProxy>.

miniProxy is licensed under the GNU GPL v3 <https://www.gnu.org/licenses/gpl-3.0.html>.
*/

// Configuration
$whitelistPatterns = [];
$blacklistPatterns = [];
$forceCORS = false;
$disallowLocal = true;
$anonymize = true;
$startURL = "";
$landingExampleURL = "https://example.net";

// Vercel-specific adjustments
ob_start("ob_gzhandler");

// Check PHP version and required extensions
if (version_compare(PHP_VERSION, "8.0.0", "<")) {
    http_response_code(500);
    die("miniProxy requires PHP version 8.0.0 or later.");
}

$requiredExtensions = ["curl", "mbstring", "xml"];
foreach ($requiredExtensions as $requiredExtension) {
    if (!extension_loaded($requiredExtension)) {
        http_response_code(500);
        die("miniProxy requires PHP's \"$requiredExtension\" extension.");
    }
}

// Helper function to generate hostname regex pattern
function getHostnamePattern($hostname) {
    $escapedHostname = str_replace(".", "\.", $hostname);
    return "@^https?://([a-z0-9-]+\.)*" . $escapedHostname . "@i";
}

// Validate URL against whitelist, blacklist, and local restrictions
function isValidURL($url) {
    function passesWhitelist($url) {
        if (count($GLOBALS['whitelistPatterns']) === 0) return true;
        foreach ($GLOBALS['whitelistPatterns'] as $pattern) {
            if (preg_match($pattern, $url)) return true;
        }
        return false;
    }

    function passesBlacklist($url) {
        foreach ($GLOBALS['blacklistPatterns'] as $pattern) {
            if (preg_match($pattern, $url)) return false;
        }
        return true;
    }

    function isLocal($url) {
        $host = parse_url($url, PHP_URL_HOST);
        $ips = [];
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            $ips = [$host];
        } else {
            $dnsResult = dns_get_record($host, DNS_A + DNS_AAAA);
            $ips = array_map(function($dnsRecord) {
                return $dnsRecord['type'] == 'A' ? $dnsRecord['ip'] : $dnsRecord['ipv6'];
            }, $dnsResult);
        }
        foreach ($ips as $ip) {
            if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                return true;
            }
        }
        return false;
    }

    return passesWhitelist($url) && passesBlacklist($url) && ($GLOBALS['disallowLocal'] ? !isLocal($url) : true);
}

// Remove keys from associative array (case-insensitive)
function removeKeys(&$assoc, $keys2remove) {
    $keys = array_keys($assoc);
    $map = [];
    $removedKeys = [];
    foreach ($keys as $key) {
        $map[strtolower($key)] = $key;
    }
    foreach ($keys2remove as $key) {
        $key = strtolower($key);
        if (isset($map[$key])) {
            unset($assoc[$map[$key]]);
            $removedKeys[] = $map[$key];
        }
    }
    return $removedKeys;
}

// Polyfill for getallheaders if not available
if (!function_exists("getallheaders")) {
    function getallheaders() {
        $result = [];
        foreach ($_SERVER as $key => $value) {
            if (substr($key, 0, 5) == "HTTP_") {
                $key = str_replace(" ", "-", ucwords(strtolower(str_replace("_", " ", substr($key, 5)))));
                $result[$key] = $value;
            }
        }
        return $result;
    }
}

// Define PROXY_PREFIX for Vercel
$usingDefaultPort = (!isset($_SERVER["HTTPS"]) && $_SERVER["SERVER_PORT"] === 80) || (isset($_SERVER["HTTPS"]) && $_SERVER["SERVER_PORT"] === 443);
$prefixPort = $usingDefaultPort ? "" : ":" . $_SERVER["SERVER_PORT"];
$prefixHost = $_SERVER["HTTP_HOST"];
$prefixHost = strpos($prefixHost, ":") ? implode(":", explode(":", $_SERVER["HTTP_HOST"], -1)) : $prefixHost;
define("PROXY_PREFIX", "http" . (isset($_SERVER["HTTPS"]) ? "s" : "") . "://" . $prefixHost . $prefixPort . "/api/miniproxy.php?");

// Make HTTP request via cURL
function makeRequest($url) {
    global $anonymize;
    $ch = curl_init();
    $user_agent = $_SERVER["HTTP_USER_AGENT"] ?? "Mozilla/5.0 (compatible; miniProxy)";
    curl_setopt($ch, CURLOPT_USERAGENT, $user_agent);

    $browserRequestHeaders = getallheaders();
    $removedHeaders = removeKeys($browserRequestHeaders, ["Accept-Encoding", "Content-Length", "Host", "Origin"]);
    $removedHeaders = array_map("strtolower", $removedHeaders);

    $curlRequestHeaders = [];
    foreach ($browserRequestHeaders as $name => $value) {
        $curlRequestHeaders[] = "$name: $value";
    }
    if (!$anonymize) {
        $curlRequestHeaders[] = "X-Forwarded-For: " . $_SERVER["REMOTE_ADDR"];
    }
    if (in_array("origin", $removedHeaders)) {
        $urlParts = parse_url($url);
        $port = $urlParts["port"] ?? "";
        $curlRequestHeaders[] = "Origin: " . $urlParts["scheme"] . "://" . $urlParts["host"] . (empty($port) ? "" : ":" . $port);
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $curlRequestHeaders);
    curl_setopt($ch, CURLOPT_ENCODING, "");

    switch ($_SERVER["REQUEST_METHOD"]) {
        case "POST":
            curl_setopt($ch, CURLOPT_POST, true);
            $postData = [];
            parse_str(file_get_contents("php://input"), $postData);
            if (isset($postData["miniProxyFormAction"])) {
                unset($postData["miniProxyFormAction"]);
            }
            curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($postData));
            break;
        case "PUT":
            curl_setopt($ch, CURLOPT_PUT, true);
            curl_setopt($ch, CURLOPT_INFILE, fopen("php://input", "r"));
            break;
    }

    curl_setopt($ch, CURLOPT_HEADER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_URL, $url);

    $response = curl_exec($ch);
    $responseInfo = curl_getinfo($ch);
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    $responseHeaders = substr($response, 0, $headerSize);
    $responseBody = substr($response, $headerSize);

    return ["headers" => $responseHeaders, "body" => $responseBody, "responseInfo" => $responseInfo];
}

// Convert relative URLs to absolute
function rel2abs($rel, $base) {
    if (empty($rel)) $rel = ".";
    if (parse_url($rel, PHP_URL_SCHEME) != "" || strpos($rel, "//") === 0) return $rel;
    if ($rel[0] == "#" || $rel[0] == "?") return $base . $rel;
    extract(parse_url($base));
    $path = isset($path) ? preg_replace("#/[^/]*$#", "", $path) : "/";
    if ($rel[0] == "/") $path = "";
    $port = isset($port) && $port != 80 ? ":" . $port : "";
    $auth = isset($user) ? ($pass ? "$user:$pass@" : "$user@") : "";
    $abs = "$auth$host$port$path/$rel";
    for ($n = 1; $n > 0; $abs = preg_replace(["#(/\.?/)#", "#/(?!\.\.)[^/]+/\.\./#"], "/", $abs, -1, $n)) {}
    return $scheme . "://" . $abs;
}

// Proxify CSS url() references
function proxifyCSS($css, $baseURL) {
    $sourceLines = explode("\n", $css);
    $normalizedLines = [];
    foreach ($sourceLines as $line) {
        if (preg_match("/@import\s+url/i", $line)) {
            $normalizedLines[] = $line;
        } else {
            $normalizedLines[] = preg_replace_callback(
                "/(@import\s+)([^;\s]+)([\s;])/i",
                function($matches) use ($baseURL) {
                    return $matches[1] . "url(" . $matches[2] . ")" . $matches[3];
                },
                $line
            );
        }
    }
    $normalizedCSS = implode("\n", $normalizedLines);
    return preg_replace_callback(
        "/url\((.*?)\)/i",
        function($matches) use ($baseURL) {
            $url = trim($matches[1], "'\"");
            if (stripos($url, "data:") === 0) return "url($url)";
            return "url(" . PROXY_PREFIX . rel2abs($url, $baseURL) . ")";
        },
        $normalizedCSS
    );
}

// Proxify srcset attributes
function proxifySrcset($srcset, $baseURL) {
    $sources = array_map("trim", explode(",", $srcset));
    $proxifiedSources = array_map(function($source) use ($baseURL) {
        $components = array_map("trim", str_split($source, strrpos($source, " ")));
        $components[0] = PROXY_PREFIX . rel2abs(ltrim($components[0], "/"), $baseURL);
        return implode($components, " ");
    }, $sources);
    return implode(", ", $proxifiedSources);
}

// Handle URL extraction
if (isset($_POST["miniProxyFormAction"])) {
    $url = $_POST["miniProxyFormAction"];
    unset($_POST["miniProxyFormAction"]);
} else {
    $queryParams = [];
    parse_str($_SERVER["QUERY_STRING"], $queryParams);
    if (isset($queryParams["miniProxyFormAction"])) {
        $formAction = $queryParams["miniProxyFormAction"];
        unset($queryParams["miniProxyFormAction"]);
        $url = $formAction . "?" . http_build_query($queryParams);
    } else {
        $url = substr($_SERVER["REQUEST_URI"], strlen("/api/miniproxy.php") + 1);
    }
}

if (empty($url)) {
    if (empty($startURL)) {
        header("Content-Type: text/html");
        echo "<html><head><title>miniProxy</title></head><body><h1>Welcome to miniProxy!</h1>Invoke like: <a href=\"" . PROXY_PREFIX . $landingExampleURL . "\">" . PROXY_PREFIX . $landingExampleURL . "</a><br /><br />Or enter a URL:<br /><br /><form onsubmit=\"if (document.getElementById('site').value) { window.location.href='" . PROXY_PREFIX . "' + document.getElementById('site').value; return false; } else { window.location.href='" . PROXY_PREFIX . $landingExampleURL . "'; return false; }\" autocomplete=\"off\"><input id=\"site\" type=\"text\" size=\"50\" /><input type=\"submit\" value=\"Proxy It!\" /></form></body></html>";
        exit;
    } else {
        $url = $startURL;
    }
} else if (strpos($url, ":/") !== strpos($url, "://")) {
    $pos = strpos($url, ":/");
    $url = substr_replace($url, "://", $pos, strlen(":/"));
}

$scheme = parse_url($url, PHP_URL_SCHEME);
if (empty($scheme)) {
    $url = strpos($url, "//") === 0 ? "http:$url" : "http://$url";
} else if (!preg_match("/^https?$/i", $scheme)) {
    http_response_code(400);
    die("Error: Only http[s] URLs are supported.");
}

if (!isValidURL($url)) {
    http_response_code(403);
    die("Error: The requested URL was disallowed.");
}

$response = makeRequest($url);
$rawResponseHeaders = $response["headers"];
$responseBody = $response["body"];
$responseInfo = $response["responseInfo"];

if ($responseInfo["url"] !== $url) {
    header("Location: " . PROXY_PREFIX . $responseInfo["url"], true, 302);
    exit;
}

$header_blacklist_pattern = "/^Content-Length|^Transfer-Encoding|^Content-Encoding.*gzip/i";
$responseHeaderBlocks = array_filter(explode("\r\n\r\n", $rawResponseHeaders));
$lastHeaderBlock = end($responseHeaderBlocks);
$headerLines = explode("\r\n", $lastHeaderBlock);
foreach ($headerLines as $header) {
    $header = trim($header);
    if (!preg_match($header_blacklist_pattern, $header)) {
        header($header, false);
    }
}
header("X-Robots-Tag: noindex, nofollow", true);

if ($forceCORS) {
    header("Access-Control-Allow-Origin: *", true);
    header("Access-Control-Allow-Credentials: true", true);
    if ($_SERVER["REQUEST_METHOD"] == "OPTIONS") {
        if (isset($_SERVER["HTTP_ACCESS_CONTROL_REQUEST_METHOD"])) {
            header("Access-Control-Allow-Methods: GET, POST, OPTIONS", true);
        }
        if (isset($_SERVER["HTTP_ACCESS_CONTROL_REQUEST_HEADERS"])) {
            header("Access-Control-Allow-Headers: {$_SERVER['HTTP_ACCESS_CONTROL_REQUEST_HEADERS']}", true);
        }
        exit;
    }
}

$contentType = $responseInfo["content_type"] ?? "";
if (stripos($contentType, "text/html") !== false) {
    $detectedEncoding = mb_detect_encoding($responseBody, "UTF-8, ISO-8859-1");
    if ($detectedEncoding) {
        $responseBody = mb_convert_encoding($responseBody, "HTML-ENTITIES", $detectedEncoding);
    }

    $doc = new DomDocument();
    @$doc->loadHTML($responseBody);
    $xpath = new DOMXPath($doc);

    foreach ($xpath->query("//form") as $form) {
        $action = $form->getAttribute("action");
        $action = empty($action) ? $url : rel2abs($action, $url);
        $form->setAttribute("action", rtrim(PROXY_PREFIX, "?"));
        $actionInput = $doc->createDocumentFragment();
        $actionInput->appendXML('<input type="hidden" name="miniProxyFormAction" value="' . htmlspecialchars($action) . '" />');
        $form->appendChild($actionInput);
    }

    foreach ($xpath->query("//meta[@http-equiv]") as $element) {
        if (strcasecmp($element->getAttribute("http-equiv"), "refresh") === 0) {
            $content = $element->getAttribute("content");
            if (!empty($content)) {
                $splitContent = preg_split("/=/", $content);
                if (isset($splitContent[1])) {
                    $element->setAttribute("content", $splitContent[0] . "=" . PROXY_PREFIX . rel2abs($splitContent[1], $url));
                }
            }
        }
    }

    foreach ($xpath->query("//style") as $style) {
        $style->nodeValue = proxifyCSS($style->nodeValue, $url);
    }

    foreach ($xpath->query("//*[@style]") as $element) {
        $element->setAttribute("style", proxifyCSS($element->getAttribute("style"), $url));
    }

    foreach ($xpath->query("//img[@srcset]") as $element) {
        $element->setAttribute("srcset", proxifySrcset($element->getAttribute("srcset"), $url));
    }

    $proxifyAttributes = ["href", "src"];
    foreach ($proxifyAttributes as $attrName) {
        foreach ($xpath->query("//*[@" . $attrName . "]") as $element) {
            $attrContent = $element->getAttribute($attrName);
            if ($attrName == "href" && preg_match("/^(about|javascript|magnet|mailto):|#/i", $attrContent)) continue;
            if ($attrName == "src" && preg_match("/^(data):/i", $attrContent)) continue;
            $attrContent = rel2abs($attrContent, $url);
            $attrContent = PROXY_PREFIX . $attrContent;
            $element->setAttribute($attrName, $attrContent);
        }
    }

    $head = $xpath->query("//head")->item(0);
    $body = $xpath->query("//body")->item(0);
    $prependElem = $head ?? $body;

    if ($prependElem) {
        $scriptElem = $doc->createElement("script");
        $scriptElem->setAttribute("type", "text/javascript");
        $scriptElem->nodeValue = '(function() {
            if (window.XMLHttpRequest) {
                function parseURI(url) {
                    var m = String(url).replace(/^\s+|\s+$/g, "").match(/^([^:\/?#]+:)?(\/\/(?:[^:@]*(?::[^:@]*)?@)?(([^:\/?#]*)(?::(\d*))?))?([^?#]*)(\?[^#]*)?(#[\s\S]*)?/);
                    return (m ? {
                        href: m[0] || "",
                        protocol: m[1] || "",
                        authority: m[2] || "",
                        host: m[3] || "",
                        hostname: m[4] || "",
                        port: m[5] || "",
                        pathname: m[6] || "",
                        search: m[7] || "",
                        hash: m[8] || ""
                    } : null);
                }
                function rel2abs(base, href) {
                    function removeDotSegments(input) {
                        var output = [];
                        input.replace(/^(\.\.?(\/|$))+/, "")
                            .replace(/\/(\.(\/|$))+/g, "/")
                            .replace(/\/\.\.$/, "/../")
                            .replace(/\/?[^\/]*/g, function(p) {
                                if (p === "/..") output.pop();
                                else output.push(p);
                            });
                        return output.join("").replace(/^\//, input.charAt(0) === "/" ? "/" : "");
                    }
                    href = parseURI(href || "");
                    base = parseURI(base || "");
                    return !href || !base ? null : (href.protocol || base.protocol) +
                        (href.protocol || href.authority ? href.authority : base.authority) +
                        removeDotSegments(href.protocol || href.authority || href.pathname.charAt(0) === "/" ? href.pathname : (href.pathname ? ((base.authority && !base.pathname ? "/" : "") + base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1) + href.pathname) : base.pathname)) +
                        (href.protocol || href.authority || href.pathname ? href.search : (href.search || base.search)) +
                        href.hash;
                }
                var proxied = window.XMLHttpRequest.prototype.open;
                window.XMLHttpRequest.prototype.open = function() {
                    if (arguments[1] !== null && arguments[1] !== undefined) {
                        var url = arguments[1];
                        url = rel2abs("' . $url . '", url);
                        if (url.indexOf("' . PROXY_PREFIX . '") == -1) {
                            url = "' . PROXY_PREFIX . '" + url;
                        }
                        arguments[1] = url;
                    }
                    return proxied.apply(this, [].slice.call(arguments));
                };
            }
        })();';
        $prependElem->insertBefore($scriptElem, $prependElem->firstChild);
    }

    echo "<!-- Proxified page constructed by miniProxy -->\n" . $doc->saveHTML();
} else if (stripos($contentType, "text/css") !== false) {
    echo proxifyCSS($responseBody, $url);
} else {
    header("Content-Length: " . strlen($responseBody), true);
    echo $responseBody;
}
