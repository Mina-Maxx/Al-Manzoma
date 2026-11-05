import { Router, Request, Response } from 'express';
import { config } from '../../config/index.js';
import { openapiSpec } from './openapi.js';

export const docsRouter = Router();

const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QuarryVault API - Swagger UI</title>
  <link rel="stylesheet" type="text/css" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>
    html {
      box-sizing: border-box;
      overflow: -moz-scrollbars-vertical;
      overflow-y: scroll;
    }
    *, *:before, *:after {
      box-sizing: inherit;
    }
    body {
      margin: 0;
      background: #fafafa;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .topbar {
      display: none;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>`;

/**
 * GET /openapi.json
 * OpenAPI 3.0.3 specification JSON
 */
docsRouter.get('/openapi.json', (_req: Request, res: Response) => {
  if (!config.enableDocs) {
    res.status(404).json({ detail: 'API documentation is disabled in this environment' });
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.json(openapiSpec);
});

/**
 * GET /docs and /docs/
 * Interactive Swagger UI documentation
 */
docsRouter.get(['/docs', '/docs/'], (_req: Request, res: Response) => {
  if (!config.enableDocs) {
    res.status(404).json({ detail: 'API documentation is disabled in this environment' });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(SWAGGER_UI_HTML);
});
