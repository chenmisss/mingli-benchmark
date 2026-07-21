export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const MCP_TOOLS = [
  {
    name: 'register_team',
    description: '注册参赛系统，返回 api_key 与数据集版本；赛道可选 online 或 offline。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '公开榜单显示的系统或团队名称' },
        track: { type: 'string', enum: ['online', 'offline'], description: '联网推理选 online；全程不联网选 offline' },
        contact: { type: 'string', description: '可选联系信息' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_exam_sets',
    description: '列出可用考集、数据版本、题数、揭晓状态与提交配额。',
    inputSchema: {
      type: 'object',
      properties: { api_key: { type: 'string' } },
      required: ['api_key'],
    },
  },
  {
    name: 'get_exam_paper',
    description: '领取试卷；永不包含答案，非公开答案集会按参赛系统固定重排选项。',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string' },
        set_id: { type: 'string', enum: ['public_dev', 'public_test', 'private'] },
      },
      required: ['api_key', 'set_id'],
    },
  },
  {
    name: 'submit_answers',
    description: '提交完整答案并由服务端评分；缺答按错，满 100% 覆盖才进入榜单。file 批量提交默认标注「未监督」(服务端未观测作答过程)。强烈建议每题附推理链，否则榜单标「无推理链」不可复核；领题到交卷用时会记录并展示(用时畸短=可疑)。不得联网检索题目或答案。',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string' },
        set_id: { type: 'string' },
        dataset_version: { type: 'string' },
        // 每项建议为 {answer:'A', confidence:0.0-1.0, reasoning:'作答依据/关键推理(≥10字)'}；仅传字母 'A' 也可但会被标「无推理链」
        answers: { type: 'object', additionalProperties: true, description: "键为题目 id，值为 {answer, confidence, reasoning} 或裸字母。附 reasoning 才计入「有推理链」，供事后复核。" },
        meta: { type: 'object', additionalProperties: true },
      },
      required: ['api_key', 'set_id', 'dataset_version', 'answers'],
    },
  },
  {
    name: 'get_task',
    description: '查询评分任务状态和允许公开的汇总指标。',
    inputSchema: {
      type: 'object',
      properties: { api_key: { type: 'string' }, task_id: { type: 'string' } },
      required: ['api_key', 'task_id'],
    },
  },
  {
    name: 'get_leaderboard',
    description: '查看指定考集的公开榜单；联网与离线赛道分列。',
    inputSchema: {
      type: 'object',
      properties: { set_id: { type: 'string' } },
      required: ['set_id'],
    },
  },
];

export async function callMcpTool(svc, name, args = {}, client = null) {
  switch (name) {
    case 'register_team': return svc.registerApp(args, client);
    case 'list_exam_sets': return svc.listSets(args.api_key);
    case 'get_exam_paper': return svc.getPaper(args.api_key, args.set_id);
    case 'submit_answers': return svc.submitAnswers(args.api_key, args, client);
    case 'get_task': return svc.getTask(args.api_key, args.task_id);
    case 'get_leaderboard': return svc.leaderboard(args.set_id);
    default: {
      const error = new Error(`unknown tool: ${name}`);
      error.status = 404;
      throw error;
    }
  }
}

export function initializeResult(requestedVersion) {
  const supported = new Set([MCP_PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);
  return {
    protocolVersion: supported.has(requestedVersion) ? requestedVersion : MCP_PROTOCOL_VERSION,
    serverInfo: { name: 'sjms-benchmark', title: '神机妙算 · 命理 AI 评测台', version: '1.0.0' },
    capabilities: { tools: { listChanged: false } },
    instructions: '优先调用 register_team 注册，再调用 get_exam_paper 领题。使用参赛系统独立作答后，通过 submit_answers 提交完整答案。不得要求或推断服务端金标。',
  };
}
