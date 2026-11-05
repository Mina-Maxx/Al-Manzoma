export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'QuarryVault API',
    version: '1.0.0',
    description: 'REST API documentation for QuarryVault backend (Express + TypeScript + MongoDB + Cloudflare R2).',
  },
  servers: [
    {
      url: '/',
      description: 'Current API Server',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT Access Token obtained from /auth/login',
      },
      companyIdHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Company-Id',
        description: 'Target Company ID context for operations requiring company scope',
      },
      idempotencyKeyHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'Idempotency-Key',
        description: 'Unique client-generated idempotency key (UUID) to prevent duplicate operations',
      },
    },
  },
  paths: {
    '/health': {
      get: {
        summary: 'Service Health Check',
        description: 'Returns health status of database connection, storage backend, and API service.',
        responses: {
          '200': {
            description: 'Service is healthy or degraded',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                    version: { type: 'string', example: '1.0.0' },
                    timestamp: { type: 'string', format: 'date-time' },
                    services: {
                      type: 'object',
                      properties: {
                        api: { type: 'string', example: 'healthy' },
                        database: { type: 'string', example: 'healthy' },
                        storage: { type: 'string', example: 'healthy' },
                        storage_backend: { type: 'string', example: 'local' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Authenticate User',
        description: 'Authenticates a user using username or email along with password, returning a JWT token.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password'],
                properties: {
                  username: { type: 'string', example: 'superadmin' },
                  email: { type: 'string', example: 'admin@quarryvault.local' },
                  password: { type: 'string', format: 'password', example: 'Admin@123456' },
                  company_id: { type: 'string', example: 'c1234567-89ab-cdef-0123-456789abcdef' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Authentication successful',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    access_token: { type: 'string' },
                    token_type: { type: 'string', example: 'bearer' },
                    expires_in: { type: 'integer', example: 86400 },
                    user: { type: 'object' },
                    must_change_password: { type: 'boolean' },
                  },
                },
              },
            },
          },
          '401': { description: 'Invalid username or password' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        summary: 'Refresh Access Token',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Token refreshed successfully' },
          '401': { description: 'Invalid or expired token' },
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Logout User',
        security: [{ bearerAuth: [] }],
        description: 'Revokes active tokens for the authenticated user.',
        responses: {
          '200': { description: 'Logged out successfully' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/auth/change-password': {
      post: {
        summary: 'Change User Password',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['current_password', 'new_password'],
                properties: {
                  current_password: { type: 'string', format: 'password' },
                  new_password: { type: 'string', format: 'password' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Password changed successfully' },
          '400': { description: 'Weak new password or mismatch' },
          '401': { description: 'Current password invalid or unauthorized' },
        },
      },
    },
    '/auth/verify-token': {
      post: {
        summary: 'Verify Access Token',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Token is valid' },
          '401': { description: 'Token is invalid or expired' },
        },
      },
    },
    '/me': {
      get: {
        summary: 'Get Current Authenticated User Context',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'User details, roles, and company quota summary',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { type: 'object' },
                    company: { type: 'object', nullable: true },
                    role: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/quarries': {
      get: {
        summary: 'List Quarries',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        responses: {
          '200': { description: 'List of accessible quarries' },
          '401': { description: 'Unauthorized' },
        },
      },
      post: {
        summary: 'Create Quarry',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', example: 'Granite Ridge' },
                  location: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Quarry created successfully' },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden - requires Company Admin or Platform Admin' },
        },
      },
    },
    '/quarries/{quarry_id}': {
      get: {
        summary: 'Get Quarry Details',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'quarry_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Quarry details' },
          '404': { description: 'Quarry not found' },
        },
      },
      patch: {
        summary: 'Update Quarry',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'quarry_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Quarry updated successfully' },
          '404': { description: 'Quarry not found' },
        },
      },
    },
    '/documents': {
      get: {
        summary: 'List Documents',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'quarry_id', in: 'query', schema: { type: 'string' } },
          { name: 'folder_id', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'deleted'] } },
        ],
        responses: {
          '200': { description: 'List of documents matching filter' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
    '/documents/upload': {
      post: {
        summary: 'Upload Document',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }, { idempotencyKeyHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file', 'quarry_id'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  quarry_id: { type: 'string' },
                  folder_id: { type: 'string' },
                  title: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Document uploaded and persisted in R2/local storage' },
          '409': { description: 'Quota exceeded or duplicate upload' },
        },
      },
    },
    '/documents/{doc_id}': {
      get: {
        summary: 'Get Document Metadata',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'doc_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Document metadata' },
          '404': { description: 'Document not found' },
        },
      },
      delete: {
        summary: 'Soft Delete Document',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'doc_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Document moved to trash (30-day retention)' },
          '404': { description: 'Document not found' },
        },
      },
    },
    '/documents/{doc_id}/download': {
      get: {
        summary: 'Download Document Binary Stream',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'doc_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Binary document payload',
            content: {
              'application/octet-stream': {},
            },
          },
          '404': { description: 'Document not found' },
        },
      },
    },
    '/documents/{doc_id}/rename': {
      patch: {
        summary: 'Rename Document (Rename Only)',
        description: 'Updates document display_name and filename metadata only. Requires can_view permission.',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'doc_id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'If-Match', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', description: 'New filename or display name' },
                  display_name: { type: 'string', description: 'Alternative alias for name' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Updated document metadata' },
          '400': { description: 'Invalid filename or prohibited extension modification' },
          '403': { description: 'Permission denied' },
          '404': { description: 'Document not found' },
          '409': { description: 'Duplicate filename in folder' },
        },
      },
    },
    '/documents/trash/list': {
      get: {
        summary: 'List Trash Documents',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        responses: {
          '200': { description: 'List of soft-deleted documents' },
        },
      },
    },
    '/documents/{doc_id}/restore': {
      post: {
        summary: 'Restore Soft-Deleted Document',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'doc_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Document restored to active status' },
          '404': { description: 'Document not found in trash' },
        },
      },
    },
    '/folders': {
      get: {
        summary: 'List Folders',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'quarry_id', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Folder tree or list' },
        },
      },
      post: {
        summary: 'Create Folder',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['quarry_id', 'name'],
                properties: {
                  quarry_id: { type: 'string' },
                  parent_id: { type: 'string', nullable: true },
                  name: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Folder created' },
        },
      },
    },
    '/folders/{folder_id}': {
      delete: {
        summary: 'Delete Empty Folder',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'folder_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Folder deleted' },
          '409': { description: 'Folder is not empty' },
        },
      },
    },
    '/sync/changes': {
      get: {
        summary: 'Get Incremental Sync Changes Feed',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'HMAC signed cursor' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
        ],
        responses: {
          '200': { description: 'List of change log events and next_cursor' },
        },
      },
    },
    '/sync/ack': {
      post: {
        summary: 'Acknowledge Sync Cursor',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cursor'],
                properties: {
                  cursor: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Cursor acknowledged' },
        },
      },
    },
    '/platform/overview': {
      get: {
        summary: 'Platform Overview Metrics',
        security: [{ bearerAuth: [] }],
        description: 'Returns platform-wide totals for companies, users, and storage. (Platform Admin only)',
        responses: {
          '200': { description: 'Overview statistics' },
          '403': { description: 'Forbidden - Platform Admin required' },
        },
      },
    },
    '/platform/companies': {
      get: {
        summary: 'List All Companies',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'List of companies' },
          '403': { description: 'Forbidden' },
        },
      },
      post: {
        summary: 'Provision New Company Tenant',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', example: 'Acme Quarries Ltd' },
                  quota_bytes: { type: 'integer', example: 5368709120 },
                  max_users: { type: 'integer', example: 10 },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Company created' },
          '403': { description: 'Forbidden' },
        },
      },
    },
    '/platform/companies/{company_id}/status': {
      patch: {
        summary: 'Update Company Status',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'company_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: { type: 'string', enum: ['active', 'suspended'] },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Company status updated' },
        },
      },
    },
    '/platform/companies/{company_id}/quota': {
      patch: {
        summary: 'Update Company Quota and Max Users',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'company_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  quota_bytes: { type: 'integer' },
                  max_users: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Company quota updated' },
        },
      },
    },
    '/platform/users': {
      get: {
        summary: 'List Global Users',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'role', in: 'query', schema: { type: 'string' } },
          { name: 'company_id', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'List of platform users' },
        },
      },
      post: {
        summary: 'Provision User Account (Employee, Company Admin, or Platform Admin)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'email'],
                properties: {
                  username: { type: 'string', example: 'emp_john' },
                  email: { type: 'string', example: 'john@example.com' },
                  password: { type: 'string', format: 'password' },
                  role: { type: 'string', enum: ['employee', 'company_admin', 'platform_admin'], default: 'employee' },
                  company_id: { type: 'string', example: 'c1234567-89ab-cdef-0123-456789abcdef' },
                  fullName: { type: 'string', example: 'John Doe' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'User provisioned successfully' },
          '400': { description: 'Validation error' },
          '404': { description: 'Company not found' },
          '409': { description: 'Duplicate username or email, or company quota full' },
        },
      },
    },
    '/platform/admins': {
      get: {
        summary: 'List Platform Admins',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'List of platform admins' },
        },
      },
      post: {
        summary: 'Create Platform Admin',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string' },
                  email: { type: 'string' },
                  password: { type: 'string', format: 'password' },
                  full_name: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Platform admin created' },
        },
      },
    },
    '/company/employees': {
      get: {
        summary: 'List Company Employees',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        responses: {
          '200': { description: 'List of employees and roles' },
          '403': { description: 'Forbidden - Company Admin required' },
        },
      },
      post: {
        summary: 'Create Employee',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password', 'role'],
                properties: {
                  username: { type: 'string' },
                  password: { type: 'string', format: 'password' },
                  email: { type: 'string' },
                  full_name: { type: 'string' },
                  role: { type: 'string', enum: ['company_admin', 'employee'] },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Employee created' },
        },
      },
    },
    '/company/employees/invite': {
      post: {
        summary: 'Create Employee Invitation',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'role'],
                properties: {
                  email: { type: 'string' },
                  role: { type: 'string', enum: ['company_admin', 'employee'] },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Invitation token created' },
        },
      },
    },
    '/company/employees/{user_id}/status': {
      patch: {
        summary: 'Update Employee Status',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'user_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: { type: 'string', enum: ['active', 'suspended'] },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Status updated' },
        },
      },
    },
    '/company/employees/{user_id}/role': {
      patch: {
        summary: 'Update Employee Role',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'user_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['role'],
                properties: {
                  role: { type: 'string', enum: ['company_admin', 'employee'] },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Role updated' },
        },
      },
    },
    '/company/employees/{user_id}/reset-password': {
      post: {
        summary: 'Reset Employee Password by Company Admin',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'user_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  new_password: { type: 'string', format: 'password' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Password reset' },
        },
      },
    },
    '/company/quarries': {
      get: {
        summary: 'List Company Quarries',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        responses: {
          '200': { description: 'Company quarries list' },
        },
      },
    },
    '/company/permissions': {
      get: {
        summary: 'List User Quarry Permissions',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'user_id', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'User quarry permission list' },
        },
      },
      put: {
        summary: 'Update User Quarry Permissions',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['user_id', 'quarry_ids'],
                properties: {
                  user_id: { type: 'string' },
                  quarry_ids: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Permissions updated' },
        },
      },
    },
    '/company/usage': {
      get: {
        summary: 'Get Company Quota Usage',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        responses: {
          '200': { description: 'Storage bytes used, document count, active user count' },
        },
      },
    },
    '/company/audit': {
      get: {
        summary: 'Query Company Audit Trail',
        security: [{ bearerAuth: [] }, { companyIdHeader: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          '200': { description: 'Audit trail records' },
        },
      },
    },
    '/app/updates/latest': {
      get: {
        summary: 'Check Latest Android App Release',
        parameters: [
          { name: 'current_version_code', in: 'query', schema: { type: 'integer' } },
          { name: 'X-App-Version-Code', in: 'header', schema: { type: 'integer' } },
        ],
        responses: {
          '200': { description: 'Release details and update flag' },
          '404': { description: 'No releases published' },
        },
      },
    },
    '/app/updates/download/{versionCode}': {
      get: {
        summary: 'Download Android APK Release',
        parameters: [
          { name: 'versionCode', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'APK binary stream',
            content: {
              'application/vnd.android.package-archive': {},
            },
          },
          '404': { description: 'Release not found' },
        },
      },
    },
    '/dashboard/config': {
      get: {
        summary: 'Public Admin Dashboard Configuration',
        responses: {
          '200': {
            description: 'Supabase URL and anonymous key for dashboard client bootstrap',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    supabase_url: { type: 'string' },
                    supabase_anon_key: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
