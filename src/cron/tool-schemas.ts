// Shared by standalone MCP and scoped container workers.
export const CRON_TOOLS = [
      {
        name: 'cron_list',
        description: 'List scheduled cron jobs for this agent',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'cron_create',
        description: 'Create a new cron job',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Job name' },
            schedule: { type: 'string', description: '5-field cron expression' },
            type: { type: 'string', enum: ['command', 'agent'], description: 'Job type' },
            command: { type: 'string', description: 'Shell command (type=command)' },
            prompt: { type: 'string', description: 'Agent prompt (type=agent)' },
            telegram: { type: 'string', description: 'Telegram chat_id for delivery — full response on success (type=agent), or a short failure notice on error (any type)' },
            discord: { type: 'string', description: 'Discord channel_id for delivery — full response on success (type=agent), or a short failure notice on error (any type)' },
            timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
            scheduleKind: {
              type: 'string',
              enum: ['cron', 'at'],
              description: 'Schedule type: "cron" for recurring (default), "at" for one-shot at a specific ISO datetime',
            },
            scheduleAt: {
              type: 'string',
              description: 'ISO 8601 datetime for one-shot execution (required when scheduleKind=at)',
            },
            deleteAfterRun: {
              type: 'boolean',
              description: 'Delete the job after it runs once. Defaults to true for scheduleKind=at, false for cron',
            },
          },
          required: ['name', 'type'],
          additionalProperties: false,
        },
      },
      {
        name: 'cron_delete',
        description: 'Delete a cron job by ID',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Job ID to delete' },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'cron_update',
        description: 'Update an existing cron job. Provide job_id plus only the fields to change.',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'ID of the job to update' },
            name: { type: 'string', description: 'Job name' },
            schedule: { type: 'string', description: '5-field cron expression' },
            type: { type: 'string', enum: ['command', 'agent'], description: 'Job type' },
            command: { type: 'string', description: 'Shell command (type=command)' },
            prompt: { type: 'string', description: 'Agent prompt (type=agent)' },
            telegram: { type: 'string', description: 'Telegram chat_id for delivery — full response on success (type=agent), or a short failure notice on error (any type)' },
            discord: { type: 'string', description: 'Discord channel_id for delivery — full response on success (type=agent), or a short failure notice on error (any type)' },
            timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
            scheduleKind: {
              type: 'string',
              enum: ['cron', 'at'],
              description: 'Schedule type: "cron" for recurring, "at" for one-shot at a specific ISO datetime',
            },
            scheduleAt: {
              type: 'string',
              description: 'ISO 8601 datetime for one-shot execution (required when scheduleKind=at)',
            },
            deleteAfterRun: {
              type: 'boolean',
              description: 'Delete the job after it runs once',
            },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'cron_run',
        description: 'Run a cron job immediately and wait for its actual result. If the wait is interrupted, the job may still be running: check cron_get_runs before retrying; do not blindly start another run.',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Job ID to run' },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'cron_get_runs',
        description: 'Get run history for a cron job',
        inputSchema: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Job ID' },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
      },
    ];

/** Container schedules execute agent prompts only; immediate run is host-only. */
export const CONTAINER_CRON_TOOLS = CRON_TOOLS.filter(t => t.name !== 'cron_run').map(tool => ({
  ...tool,
  inputSchema: { ...tool.inputSchema, properties: Object.fromEntries(
    Object.entries(tool.inputSchema.properties).filter(([name]) => name !== 'command').map(([name, schema]) =>
      [name, name === 'type' ? { type: 'string', enum: ['agent'], description: 'Scheduled agent prompt inside this app container' } : schema]),
  ) },
}));
