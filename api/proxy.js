const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const cors = require('cors');

const app = express();

// Security middleware
app.use(helmet());
app.use(morgan('combined'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // Limit to 100 requests per window
});
app.use(limiter);

// Enable CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Proxy configuration
const proxyOptions = {
    changeOrigin: true,
    ws: false, // WebSockets not supported in Vercel serverless
    logLevel: 'debug',
    onError: (err, req, res) => {
        console.error('Proxy Error:', err);
        res.status(500).json({
            error: 'Proxy error occurred',
            message: err.message
        });
    },
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.removeHeader('x-forwarded-for');
        proxyReq.removeHeader('user-agent');
        proxyReq.setHeader('X-Proxy-Server', 'Vercel-Proxy');
    },
    onProxyRes: (proxyRes, req, res) => {
        const targetCorsHeaders = [
            'access-control-allow-origin',
            'access-control-allow-methods',
            'access-control-allow-headers'
        ];
        targetCorsHeaders.forEach(header => {
            if (proxyRes.headers[header]) {
                res.setHeader(header, proxyRes.headers[header]);
            }
        });
    }
};

// Proxy endpoint
app.all('/api/proxy/*', (req, res, next) => {
    const targetUrl = req.query.url || req.originalUrl.split('/api/proxy/')[1];

    if (!targetUrl) {
        return res.status(400).json({
            error: 'No target URL provided',
            message: 'Provide a target URL using ?url= parameter or in the path'
        });
    }

    try {
        new URL(targetUrl);
        proxyOptions.target = targetUrl;
        const proxy = createProxyMiddleware(proxyOptions);
        proxy(req, res, next);
    } catch (error) {
        res.status(400).json({
            error: 'Invalid target URL',
            message: error.message
        });
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

module.exports = app;
