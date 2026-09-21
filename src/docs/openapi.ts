/**
 * OpenAPI 3.0 description of the TimeFlow API, served at /api/docs (Swagger UI)
 * and /api/docs.json. Hand-maintained alongside docs/api-contract.md.
 */

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (items: Schema): Schema => ({ type: 'array', items });
const nullable = (schema: Schema): Schema => ({ ...schema, nullable: true });
const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
const uuid: Schema = str({ format: 'uuid' });
const dateTime: Schema = str({ format: 'date-time' });
const date: Schema = str({ format: 'date', example: '2026-10-01' });
const int: Schema = { type: 'integer' };
const bool: Schema = { type: 'boolean' };
const enumOf = (...values: string[]): Schema => ({ type: 'string', enum: values });

const success = (data: Schema, description = 'Success'): Schema => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['success', 'data'],
        properties: { success: { type: 'boolean', example: true }, data, message: str() },
      },
    },
  },
});

const paginatedOf = (item: Schema): Schema => ({
  description: 'Paginated list',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { success: { type: 'boolean', example: true }, data: arrayOf(item), meta: ref('PaginationMeta') },
      },
    },
  },
});

const errors = (...codes: number[]): Record<string, Schema> =>
  Object.fromEntries(codes.map((c) => [String(c), { $ref: `#/components/responses/E${c}` }]));

const body = (schema: Schema, contentType = 'application/json'): Schema => ({
  required: true,
  content: { [contentType]: { schema } },
});

const q = (name: string, schema: Schema, description?: string): Schema => ({ name, in: 'query', required: false, schema, description });
const idParam: Schema = { name: 'id', in: 'path', required: true, schema: uuid };
const listParams = (sortable: string[]): Schema[] => [
  q('page', { ...int, minimum: 1, default: 1 }),
  q('limit', { ...int, minimum: 1, maximum: 100, default: 10 }),
  q('search', str()),
  q('sortBy', enumOf(...sortable)),
  q('sortOrder', { ...enumOf('asc', 'desc'), default: 'desc' }),
];

const secured = [{ cookieAuth: [] }, { bearerAuth: [] }];
const perm = (p: string) => `Requires permission \`${p}\`.`;

const crud = (opts: {
  tag: string;
  path: string;
  entity: string;
  sortable: string[];
  filters: Schema[];
  create: string;
  update: string;
  perms: string;
  listNote?: string;
  deleteNote?: string;
}): Record<string, Schema> => ({
  [opts.path]: {
    get: {
      tags: [opts.tag],
      summary: `List ${opts.tag.toLowerCase()}`,
      description: `${perm(`${opts.perms}.view`)} ${opts.listNote ?? ''}`,
      security: secured,
      parameters: [...listParams(opts.sortable), ...opts.filters],
      responses: { '200': paginatedOf(ref(opts.entity)), ...errors(400, 401, 403) },
    },
    post: {
      tags: [opts.tag],
      summary: `Create ${opts.entity.toLowerCase()}`,
      description: perm(`${opts.perms}.create`),
      security: secured,
      requestBody: body(ref(opts.create)),
      responses: { '201': success(ref(opts.entity), 'Created'), ...errors(400, 401, 403, 409) },
    },
  },
  [`${opts.path}/{id}`]: {
    parameters: [idParam],
    get: {
      tags: [opts.tag],
      summary: `Get ${opts.entity.toLowerCase()}`,
      description: perm(`${opts.perms}.view`),
      security: secured,
      responses: { '200': success(ref(opts.entity)), ...errors(401, 403, 404) },
    },
    patch: {
      tags: [opts.tag],
      summary: `Update ${opts.entity.toLowerCase()}`,
      description: `${perm(`${opts.perms}.update`)} Only provided fields change.`,
      security: secured,
      requestBody: body(ref(opts.update)),
      responses: { '200': success(ref(opts.entity)), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      tags: [opts.tag],
      summary: `Delete ${opts.entity.toLowerCase()}`,
      description: `${perm(`${opts.perms}.delete`)} ${opts.deleteNote ?? ''}`,
      security: secured,
      responses: { '200': success(nullable({ type: 'object' })), ...errors(401, 403, 404, 409) },
    },
  },
});

const errorResponse = (description: string, code: string, message: string): Schema => ({
  description,
  content: { 'application/json': { schema: ref('Error'), example: { success: false, code, message, requestId: 'b1f0c3e2-…' } } },
});

const priority = enumOf('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
const projectStatus = enumOf('PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED');
const taskStatus = enumOf('TODO', 'IN_PROGRESS', 'REVIEW', 'COMPLETED');
const userStatus = enumOf('ACTIVE', 'INACTIVE');

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'TimeFlow API',
    version: '1.0.0',
    description:
      'Team & Project Management API with RBAC, Redis caching / rate limiting and BullMQ background jobs.\n\n' +
      '**Auth:** `POST /api/auth/login` sets httpOnly cookies (`tf_access`, `tf_refresh`) and also returns `accessToken` ' +
      'for use with the **Authorize → bearerAuth** button.\n\nDemo logins (password `Password123!`): ' +
      '`superadmin@timeflow.dev`, `admin@timeflow.dev`, `manager@timeflow.dev`, `employee@timeflow.dev`.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Auth' },
    { name: 'Users' },
    { name: 'Roles' },
    { name: 'Projects' },
    { name: 'Tasks' },
    { name: 'Activity Logs' },
    { name: 'Dashboard' },
    { name: 'Notifications' },
    { name: 'Uploads' },
    { name: 'Emails' },
    { name: 'Queues' },
    { name: 'Health' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'tf_access' },
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    responses: {
      E400: errorResponse('Validation failed', 'VALIDATION_ERROR', 'Validation failed'),
      E401: errorResponse('Not authenticated', 'UNAUTHENTICATED', 'Authentication required'),
      E403: errorResponse('Forbidden', 'FORBIDDEN', 'You do not have permission to perform this action'),
      E404: errorResponse('Not found', 'NOT_FOUND', 'Resource not found'),
      E409: errorResponse('Conflict', 'USER_EMAIL_EXISTS', 'Email already exists'),
      E429: errorResponse('Rate limited', 'RATE_LIMITED', 'Too many requests, please try again later'),
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['success', 'message', 'code'],
        properties: {
          success: { type: 'boolean', example: false },
          message: str(),
          code: str(),
          details: arrayOf({ type: 'object', properties: { path: str(), message: str() } }),
          requestId: str(),
        },
      },
      PaginationMeta: {
        type: 'object',
        properties: { page: int, limit: int, total: int, totalPages: int },
      },
      UserRef: {
        type: 'object',
        properties: { id: uuid, firstName: str(), lastName: str(), email: str({ format: 'email' }), avatarUrl: nullable(str()) },
      },
      RoleRef: { type: 'object', properties: { id: uuid, name: str() } },
      AuthUser: {
        type: 'object',
        properties: {
          id: uuid,
          firstName: str(),
          lastName: str(),
          email: str(),
          phone: nullable(str()),
          avatarUrl: nullable(str()),
          status: userStatus,
          role: ref('RoleRef'),
          permissions: arrayOf(str({ example: 'users.view' })),
          lastLoginAt: nullable(dateTime),
          createdAt: dateTime,
        },
      },
      User: {
        allOf: [
          ref('UserRef'),
          {
            type: 'object',
            properties: {
              phone: nullable(str()),
              status: userStatus,
              role: ref('RoleRef'),
              lastLoginAt: nullable(dateTime),
              createdAt: dateTime,
              updatedAt: dateTime,
              stats: {
                type: 'object',
                description: 'Detail endpoint only',
                properties: { assignedTasks: int, completedTasks: int, projects: int },
              },
            },
          },
        ],
      },
      CreateUser: {
        type: 'object',
        additionalProperties: false,
        required: ['firstName', 'lastName', 'email', 'password', 'roleId'],
        properties: {
          firstName: str({ maxLength: 80 }),
          lastName: str({ maxLength: 80 }),
          email: str({ format: 'email' }),
          phone: nullable(str()),
          password: str({ minLength: 8, description: 'At least one letter and one number' }),
          roleId: uuid,
          status: userStatus,
          avatarUrl: nullable(str({ description: 'Value returned by POST /api/uploads/avatar' })),
        },
      },
      UpdateUser: {
        type: 'object',
        additionalProperties: false,
        properties: {
          firstName: str(),
          lastName: str(),
          email: str({ format: 'email' }),
          phone: nullable(str()),
          password: str({ minLength: 8 }),
          roleId: uuid,
          status: userStatus,
          avatarUrl: nullable(str()),
        },
      },
      Permission: {
        type: 'object',
        properties: { id: uuid, key: str({ example: 'projects.view_all' }), module: str(), action: str(), description: nullable(str()) },
      },
      Role: {
        type: 'object',
        properties: {
          id: uuid,
          name: str(),
          description: nullable(str()),
          isSystem: bool,
          permissions: arrayOf(str()),
          userCount: int,
          createdAt: dateTime,
          updatedAt: dateTime,
        },
      },
      CreateRole: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: str(), description: nullable(str()), permissions: arrayOf(str({ example: 'tasks.view' })) },
      },
      UpdateRole: {
        type: 'object',
        additionalProperties: false,
        properties: { name: str(), description: nullable(str()), permissions: arrayOf(str()) },
      },
      Project: {
        type: 'object',
        properties: {
          id: uuid,
          name: str(),
          description: nullable(str()),
          status: projectStatus,
          priority,
          startDate: dateTime,
          endDate: nullable(dateTime),
          manager: ref('UserRef'),
          members: arrayOf(ref('UserRef')),
          taskStats: { type: 'object', properties: { total: int, completed: int } },
          createdAt: dateTime,
          updatedAt: dateTime,
        },
      },
      CreateProject: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'startDate', 'managerId'],
        properties: {
          name: str(),
          description: nullable(str()),
          status: projectStatus,
          priority,
          startDate: date,
          endDate: nullable(date),
          managerId: uuid,
          memberIds: arrayOf(uuid),
        },
      },
      UpdateProject: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: str(),
          description: nullable(str()),
          status: projectStatus,
          priority,
          startDate: date,
          endDate: nullable(date),
          managerId: uuid,
          memberIds: { ...arrayOf(uuid), description: 'Replaces the member set' },
        },
      },
      Task: {
        type: 'object',
        properties: {
          id: uuid,
          title: str(),
          description: nullable(str()),
          project: { type: 'object', properties: { id: uuid, name: str() } },
          assignee: nullable(ref('UserRef')),
          createdBy: nullable(ref('UserRef')),
          status: taskStatus,
          priority,
          dueDate: nullable(dateTime),
          completedAt: nullable(dateTime),
          createdAt: dateTime,
          updatedAt: dateTime,
        },
      },
      CreateTask: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'projectId'],
        properties: {
          title: str(),
          description: nullable(str()),
          projectId: uuid,
          assigneeId: nullable(uuid),
          status: taskStatus,
          priority,
          dueDate: nullable(date),
        },
      },
      UpdateTask: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: str(),
          description: nullable(str()),
          projectId: uuid,
          assigneeId: nullable(uuid),
          status: taskStatus,
          priority,
          dueDate: nullable(date),
        },
      },
      ActivityLog: {
        type: 'object',
        properties: {
          id: uuid,
          action: str({ example: 'task.status_changed' }),
          entity: str({ example: 'task' }),
          entityId: nullable(str()),
          description: str(),
          metadata: { type: 'object', additionalProperties: true },
          ipAddress: nullable(str()),
          user: nullable(ref('UserRef')),
          createdAt: dateTime,
        },
      },
      Notification: {
        type: 'object',
        properties: {
          id: uuid,
          type: str(),
          title: str(),
          body: nullable(str()),
          link: nullable(str()),
          readAt: nullable(dateTime),
          createdAt: dateTime,
        },
      },
      Dashboard: {
        type: 'object',
        properties: {
          stats: {
            type: 'object',
            properties: {
              totalUsers: nullable(int),
              activeUsers: nullable(int),
              totalProjects: int,
              activeProjects: int,
              totalTasks: int,
              completedTasks: int,
            },
          },
          tasksByStatus: arrayOf({ type: 'object', properties: { status: taskStatus, count: int } }),
          projectsByStatus: arrayOf({ type: 'object', properties: { status: projectStatus, count: int } }),
          recentProjects: arrayOf(ref('Project')),
          recentActivity: arrayOf(ref('ActivityLog')),
          myTasks: arrayOf(ref('Task')),
        },
      },
      QueueSummary: {
        type: 'object',
        properties: {
          name: enumOf('email', 'activity', 'email-dead-letter'),
          counts: {
            type: 'object',
            properties: { waiting: int, active: int, completed: int, failed: int, delayed: int },
          },
        },
      },
      QueueJob: {
        type: 'object',
        properties: {
          id: str(),
          name: str(),
          data: { type: 'object' },
          attemptsMade: int,
          attempts: int,
          failedReason: nullable(str()),
          timestamp: int,
          processedOn: nullable(int),
          finishedOn: nullable(int),
        },
      },
      EmailLog: {
        type: 'object',
        properties: {
          id: uuid,
          to: str(),
          fromAddress: str(),
          subject: str(),
          template: str(),
          status: enumOf('QUEUED', 'SENT', 'FAILED'),
          attempts: int,
          lastError: nullable(str()),
          readAt: nullable(dateTime),
          sentAt: nullable(dateTime),
          createdAt: dateTime,
          toUser: nullable(ref('UserRef')),
          fromUser: nullable(ref('UserRef')),
        },
      },
      EmailDetail: {
        type: 'object',
        description: 'An EmailLog plus the rendered body, returned by `GET /api/emails/{id}`.',
        properties: {
          id: uuid,
          to: str(),
          fromAddress: str(),
          subject: str(),
          template: str(),
          status: enumOf('QUEUED', 'SENT', 'FAILED'),
          attempts: int,
          lastError: nullable(str()),
          readAt: nullable(dateTime),
          sentAt: nullable(dateTime),
          createdAt: dateTime,
          bodyHtml: nullable(str()),
          bodyText: nullable(str()),
          jobId: nullable(str()),
          toUserId: nullable(uuid),
          fromUserId: nullable(uuid),
        },
      },
      EmailStats: {
        type: 'object',
        properties: {
          total: int,
          queued: int,
          sent: int,
          failed: int,
          unread: int,
          last24h: int,
          scope: enumOf('all', 'own'),
        },
      },
    },
  },
  paths: {
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in',
        description: 'Rate limited to 5 attempts per minute per IP. Sets `tf_access` and `tf_refresh` httpOnly cookies.',
        requestBody: body({
          type: 'object',
          required: ['email', 'password'],
          properties: { email: str({ example: 'superadmin@timeflow.dev' }), password: str({ example: 'Password123!' }) },
        }),
        responses: {
          '200': success({ type: 'object', properties: { user: ref('AuthUser'), accessToken: str() } }),
          '401': errorResponse('Invalid credentials', 'INVALID_CREDENTIALS', 'Invalid email or password'),
          '403': errorResponse('Inactive account', 'ACCOUNT_INACTIVE', 'Your account is inactive. Contact an administrator.'),
          ...errors(400, 429),
        },
      },
    },
    '/api/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Sign up',
        description:
          'Creates an active account with the **Employee** role and signs it in. Rate limited like login. Sets `tf_access` and `tf_refresh` httpOnly cookies.',
        requestBody: body({
          type: 'object',
          required: ['firstName', 'lastName', 'email', 'password'],
          properties: {
            firstName: str({ example: 'Sam' }),
            lastName: str({ example: 'Rivera' }),
            email: str({ example: 'sam@company.com' }),
            password: str({ example: 'Signup1234', description: 'At least 8 characters, with a letter and a number' }),
          },
        }),
        responses: {
          '201': success({ type: 'object', properties: { user: ref('AuthUser'), accessToken: str() } }),
          '409': errorResponse('Email taken', 'USER_EMAIL_EXISTS', 'An account with this email already exists'),
          ...errors(400, 429),
        },
      },
    },
    '/api/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate refresh token',
        description: 'Uses the `tf_refresh` cookie. Re-using a rotated token revokes the entire token family.',
        responses: { '200': success({ type: 'object', properties: { user: ref('AuthUser'), accessToken: str() } }), ...errors(401, 429) },
      },
    },
    '/api/auth/logout': {
      post: { tags: ['Auth'], summary: 'Sign out', responses: { '200': success(nullable({ type: 'object' })) } },
    },
    '/api/auth/me': {
      get: { tags: ['Auth'], summary: 'Current user', security: secured, responses: { '200': success(ref('AuthUser')), ...errors(401) } },
    },

    ...crud({
      tag: 'Users',
      path: '/api/users',
      entity: 'User',
      perms: 'users',
      sortable: ['createdAt', 'firstName', 'lastName', 'email', 'status', 'lastLoginAt'],
      filters: [q('status', userStatus), q('roleId', uuid)],
      create: 'CreateUser',
      update: 'UpdateUser',
      listNote: '`search` matches name, email and phone.',
      deleteNote: 'Soft delete; revokes all sessions. You cannot delete yourself or out-ranking users.',
    }),
    '/api/users/{id}/status': {
      patch: {
        tags: ['Users'],
        summary: 'Activate / deactivate user',
        description: `${perm('users.update')} Deactivation revokes sessions immediately.`,
        security: secured,
        parameters: [idParam],
        requestBody: body({ type: 'object', required: ['status'], properties: { status: userStatus } }),
        responses: { '200': success(ref('User')), ...errors(400, 401, 403, 404) },
      },
    },
    '/api/users/options': {
      get: {
        tags: ['Users'],
        summary: 'Active users for pickers',
        security: secured,
        parameters: [q('search', str())],
        responses: { '200': success(arrayOf(ref('UserRef'))), ...errors(401) },
      },
    },

    '/api/permissions': {
      get: {
        tags: ['Roles'],
        summary: 'List all permissions',
        description: perm('roles.view'),
        security: secured,
        responses: { '200': success(arrayOf(ref('Permission'))), ...errors(401, 403) },
      },
    },
    ...crud({
      tag: 'Roles',
      path: '/api/roles',
      entity: 'Role',
      perms: 'roles',
      sortable: ['name', 'createdAt'],
      filters: [],
      create: 'CreateRole',
      update: 'UpdateRole',
      deleteNote: 'The Super Admin role cannot be deleted; roles with users return 409 `ROLE_IN_USE`.',
    }),
    '/api/roles/{id}/users': {
      get: {
        tags: ['Roles'],
        summary: 'Users assigned to a role',
        description: perm('roles.view'),
        security: secured,
        parameters: [idParam, ...listParams(['createdAt', 'firstName', 'email'])],
        responses: { '200': paginatedOf(ref('User')), ...errors(401, 403, 404) },
      },
    },

    ...crud({
      tag: 'Projects',
      path: '/api/projects',
      entity: 'Project',
      perms: 'projects',
      sortable: ['createdAt', 'name', 'startDate', 'endDate', 'priority', 'status'],
      filters: [q('status', projectStatus), q('priority', priority), q('managerId', uuid)],
      create: 'CreateProject',
      update: 'UpdateProject',
      listNote:
        'Redis cached — response header `X-Cache: HIT|MISS`. Without `projects.view_all` only projects you manage or belong to are returned.',
      deleteNote: 'Soft delete; the project’s tasks are soft-deleted in the same transaction.',
    }),

    ...crud({
      tag: 'Tasks',
      path: '/api/tasks',
      entity: 'Task',
      perms: 'tasks',
      sortable: ['createdAt', 'title', 'dueDate', 'priority', 'status'],
      filters: [
        q('status', taskStatus),
        q('priority', priority),
        q('projectId', uuid),
        q('assigneeId', str({ description: 'User id or `me`' })),
      ],
      create: 'CreateTask',
      update: 'UpdateTask',
      listNote:
        'Without `tasks.view_all` returns tasks assigned to you, created by you, or in projects you manage. Non-managers may only change `status` of their own tasks.',
    }),

    '/api/activity-logs': {
      get: {
        tags: ['Activity Logs'],
        summary: 'List activity',
        description: perm('activity_logs.view'),
        security: secured,
        parameters: [
          ...listParams(['createdAt', 'action', 'entity']),
          q('entity', str({ example: 'project' })),
          q('action', str({ example: 'task.status_changed' })),
          q('userId', uuid),
          q('from', date),
          q('to', date),
        ],
        responses: { '200': paginatedOf(ref('ActivityLog')), ...errors(400, 401, 403) },
      },
    },
    '/api/activity-logs/stats': {
      get: {
        tags: ['Activity Logs'],
        summary: 'Activity counts per day, per entity and per action',
        description: `${perm('activity_logs.view')} Accepts the list filters. Without from/to covers the last 30 days; ranges are capped at 366 days. Days are UTC.`,
        security: secured,
        parameters: [q('search', str()), q('entity', str()), q('action', str()), q('userId', uuid), q('from', date), q('to', date)],
        responses: { '200': { description: 'Daily, per-entity and per-action counts' }, ...errors(400, 401, 403) },
      },
    },
    '/api/activity-logs/export': {
      get: {
        tags: ['Activity Logs'],
        summary: 'Export activity as CSV',
        description: `${perm('activity_logs.export')} Accepts the same filters as the list endpoint.`,
        security: secured,
        parameters: [q('search', str()), q('entity', str()), q('action', str()), q('userId', uuid), q('from', date), q('to', date)],
        responses: { '200': { description: 'CSV file', content: { 'text/csv': { schema: str() } } }, ...errors(401, 403) },
      },
    },

    '/api/dashboard': {
      get: {
        tags: ['Dashboard'],
        summary: 'Dashboard statistics',
        description: 'Redis cached per user (`X-Cache` header). Sections the caller lacks permission for are null/empty.',
        security: secured,
        responses: { '200': success(ref('Dashboard')), ...errors(401) },
      },
    },

    '/api/notifications': {
      get: {
        tags: ['Notifications'],
        summary: 'My notifications',
        description: '`meta.unread` holds the unread count.',
        security: secured,
        parameters: [q('page', int), q('limit', int), q('unread', enumOf('true', 'false'))],
        responses: { '200': paginatedOf(ref('Notification')), ...errors(401) },
      },
    },
    '/api/notifications/{id}/read': {
      patch: {
        tags: ['Notifications'],
        summary: 'Mark one as read',
        security: secured,
        parameters: [idParam],
        responses: { '200': success(nullable({ type: 'object' })), ...errors(401, 404) },
      },
    },
    '/api/notifications/read-all': {
      post: {
        tags: ['Notifications'],
        summary: 'Mark all as read',
        security: secured,
        responses: { '200': success({ type: 'object', properties: { updated: int } }), ...errors(401) },
      },
    },
    '/api/notifications/stream': {
      get: {
        tags: ['Notifications'],
        summary: 'Real-time notification stream (SSE)',
        description: 'Server-Sent Events. Emits `event: notification` with a Notification JSON payload, fanned out via Redis pub/sub.',
        security: secured,
        responses: { '200': { description: 'Event stream', content: { 'text/event-stream': { schema: str() } } }, ...errors(401) },
      },
    },

    '/api/uploads/avatar': {
      post: {
        tags: ['Uploads'],
        summary: 'Upload a profile image',
        description: 'PNG, JPEG or WebP up to 2 MB. File signature is verified server-side.',
        security: secured,
        requestBody: body(
          { type: 'object', required: ['file'], properties: { file: str({ format: 'binary' }) } },
          'multipart/form-data',
        ),
        responses: {
          '201': success({ type: 'object', properties: { url: str({ example: '/uploads/avatars/3f1c….png' }) } }),
          '413': errorResponse('File too large', 'PAYLOAD_TOO_LARGE', 'File is too large'),
          ...errors(400, 401),
        },
      },
    },

    '/api/queues': {
      get: {
        tags: ['Queues'],
        summary: 'Queue job counts',
        description: `${perm('queues.view')} Full UI at /admin/queues (Bull Board).`,
        security: secured,
        responses: { '200': success(arrayOf(ref('QueueSummary'))), ...errors(401, 403) },
      },
    },
    '/api/queues/{name}/jobs': {
      get: {
        tags: ['Queues'],
        summary: 'Jobs in a queue by state',
        description: perm('queues.view'),
        security: secured,
        parameters: [
          { name: 'name', in: 'path', required: true, schema: enumOf('email', 'activity', 'email-dead-letter') },
          q('state', { ...enumOf('waiting', 'active', 'completed', 'failed', 'delayed'), default: 'failed' }),
          q('limit', int),
        ],
        responses: { '200': success(arrayOf(ref('QueueJob'))), ...errors(401, 403, 404) },
      },
    },
    '/api/queues/{name}/jobs/{id}/retry': {
      post: {
        tags: ['Queues'],
        summary: 'Retry a failed job',
        description: perm('queues.manage'),
        security: secured,
        parameters: [
          { name: 'name', in: 'path', required: true, schema: str() },
          { name: 'id', in: 'path', required: true, schema: str() },
        ],
        responses: { '200': success({ type: 'object', properties: { id: str() } }), ...errors(401, 403, 404, 409) },
      },
    },
    '/api/emails': {
      get: {
        tags: ['Emails'],
        summary: 'List mailbox messages',
        description: `${perm('emails.view')} \`box=inbox\` returns mail addressed to you, \`box=sent\` mail your actions triggered, and \`box=all\` everything (requires \`emails.view_all\`). Bodies are omitted from list rows.`,
        security: secured,
        parameters: [
          q('page', int),
          q('limit', int),
          q('box', enumOf('inbox', 'sent', 'all')),
          q('status', enumOf('QUEUED', 'SENT', 'FAILED')),
          q('search', str()),
          q('unreadOnly', enumOf('true', 'false')),
        ],
        responses: { '200': paginatedOf(ref('EmailLog')), ...errors(401, 403) },
      },
      post: {
        tags: ['Emails'],
        summary: 'Send a message to another user',
        description: `${perm('emails.send')} An address belonging to an active user resolves to them, so it reaches their Inbox as well as SMTP. Any other address is SMTP-only from the org sender identity and additionally requires \`emails.send_external\`; an address belonging to a deactivated account is rejected.`,
        security: secured,
        requestBody: body({
          type: 'object',
          required: ['toUserId', 'subject', 'body'],
          properties: {
            toUserId: uuid,
            toEmail: str(),
            subject: str(),
            body: str(),
            replyToId: { ...uuid, description: 'Threads this under a message you are a party to.' },
          },
        }),
        responses: { '201': success({ type: 'object', properties: { id: uuid } }), ...errors(400, 401, 403, 404) },
      },
    },
    '/api/emails/stats': {
      get: {
        tags: ['Emails'],
        summary: 'Mailbox counters',
        description: `${perm('emails.view')} Scoped system-wide for holders of \`emails.view_all\`, otherwise to your own mail. Drives the System Monitor strip.`,
        security: secured,
        responses: { '200': success(ref('EmailStats')), ...errors(401, 403) },
      },
    },
    '/api/emails/{id}': {
      get: {
        tags: ['Emails'],
        summary: 'Read one message',
        description: `${perm('emails.view')} Returns the rendered body. You must be the recipient or the sender, unless you hold \`emails.view_all\`.`,
        security: secured,
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
        responses: { '200': success(ref('EmailDetail')), ...errors(401, 403, 404) },
      },
      delete: {
        tags: ['Emails'],
        summary: 'Delete a message from your mailbox',
        description: `${perm('emails.view')} A per-side soft delete: it disappears from your Inbox or Sent, the other party keeps their copy, and the delivery record survives for \`emails.view_all\`. You must be the sender or the recipient — \`emails.view_all\` does not grant this.`,
        security: secured,
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
        responses: { '200': success(nullable({ type: 'object' })), ...errors(401, 403, 404) },
      },
    },
    '/api/emails/{id}/read': {
      patch: {
        tags: ['Emails'],
        summary: 'Mark a message read or unread',
        description: `${perm('emails.view')} Only the recipient has a read state.`,
        security: secured,
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
        requestBody: body({ type: 'object', properties: { read: { type: 'boolean' } } }),
        responses: { '200': success({ type: 'object', properties: { id: uuid, readAt: nullable(dateTime) } }), ...errors(401, 403, 404) },
      },
    },

    '/health/live': {
      get: { tags: ['Health'], summary: 'Liveness probe', responses: { '200': { description: 'Process is up' } } },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness probe',
        responses: { '200': { description: 'Postgres and Redis reachable' }, '503': { description: 'A dependency is down' } },
      },
    },
  },
} as const;
