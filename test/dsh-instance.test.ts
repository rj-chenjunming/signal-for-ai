/**
 * dsh-instance 单测。
 *
 * 依赖: vitest + node:http（起真实本地服务，不 mock fetch —— 沿用项目惯例：
 * 「本项目重视真实 IO，webhook 型的测试真起了 HTTP 服务」）。
 *
 * 覆盖重点：
 *   - cookie 签名与 dsh 算法**逐字节一致**（用独立的 HMAC 复算校验）
 *   - credentials 解析的容错与明确报错
 *   - RPC 线协议的请求形状与各种失败分类
 *   - 状态判定的优先级与 failed 一票否决
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  parseSigningSecret,
  signCookie,
  deriveSessionStatus,
  deriveFromListItem,
  DshClient,
  DSH_HTML_MARKERS,
} from '../src/main/monitors/dsh-instance';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 造一段与真实 credentials 同形的文本。 */
function credentialsText(secretB64: string): string {
  return [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-fake',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${secretB64}`,
    '',
  ].join('\n');
}

/** 一枚合法的 32 字节密钥的 base64url 形式。 */
const GOOD_SECRET_B64 = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')
  .toString('base64')
  .replace(/\+/gu, '-')
  .replace(/\//gu, '_')
  .replace(/=+$/u, '');

const GOOD_SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

/** 独立复算一遍 dsh 的 cookie 算法（故意不复用被测代码）。 */
function expectedCookie(authority: string, secret: Buffer, payload: { issuedAt: number; expiresAt: number }) {
  const b64 = (b: Buffer) =>
    b.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  const name = 'dsh-auth-' + b64(createHash('sha256').update(authority, 'utf8').digest());
  const body = b64(
    Buffer.from(
      JSON.stringify({ version: 1, authority, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt }),
      'utf8',
    ),
  );
  // 密钥用**原始字节**，与 dsh-client-connection/lib/index.js 的
  // createHmac('sha256', secret) 一致。用 secret.toString('base64') 会得到
  // 完全不同的签名（这是实际踩过的坑，见 dsh-instance.ts 注释）。
  const sig = b64(createHmac('sha256', secret as unknown as string).update(body, 'utf8').digest());
  return { name, value: `v1.${body}.${sig}` };
}

/**
 * 防回归：锁死「密钥必须按原始字节参与 HMAC」这条契约。
 *
 * 这是真实踩过的坑：曾把密钥写成 secret.toString('base64')，
 * 于是用 base64 文本的 ASCII 当密钥，签名与 dsh 服务端完全对不上，
 * 表现为 cookie 名字对/格式对/长度对但一律 401 —— 极难定位。
 */
describe('cookie 签名算法契约（防回归）', () => {
  it('密钥按原始字节参与 HMAC，而不是其 base64 文本', () => {
    const authority = '127.0.0.1:3080';
    const body = 'fixedBodyForThisTest';

    const withRawBytes = createHmac('sha256', GOOD_SECRET as unknown as string)
      .update(body)
      .digest()
      .toString('base64')
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');
    const withBase64Text = createHmac('sha256', GOOD_SECRET.toString('base64'))
      .update(body)
      .digest()
      .toString('base64')
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');

    // 两种写法必须产生不同签名 —— 否则本测试失去意义
    expect(withRawBytes).not.toBe(withBase64Text);

    // 被测实现必须走"原始字节"那一种：
    // 用 signCookie 自己产出的 body 去独立复算，签名必须一致。
    const ck = signCookie(authority, GOOD_SECRET);
    const [, sameBody, sigFromImpl] = ck.value.split('.');
    const expectedSig = createHmac('sha256', GOOD_SECRET as unknown as string)
      .update(sameBody ?? '', 'utf8')
      .digest()
      .toString('base64')
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');

    expect(sigFromImpl).toBe(expectedSig);
    // 并且绝不能等于"用 base64 文本当密钥"的结果
    const wrongSig = createHmac('sha256', GOOD_SECRET.toString('base64'))
      .update(sameBody ?? '', 'utf8')
      .digest()
      .toString('base64')
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');
    expect(sigFromImpl).not.toBe(wrongSig);
  });
});

// ---------------------------------------------------------------------------
describe('parseSigningSecret', () => {
  it('从合法 credentials 文本里取出 32 字节密钥', () => {
    const secret = parseSigningSecret(credentialsText(GOOD_SECRET_B64));
    expect(secret.byteLength).toBe(32);
    expect(secret.equals(GOOD_SECRET)).toBe(true);
  });

  it('缺少 browser-session 记录时明确报错（不静默返回空）', () => {
    expect(() => parseSigningSecret('version: 1\nrefs:\n  A: b\n')).toThrow(/browser-session/);
  });

  it('记录在但缺 secret 字段时报错', () => {
    const text = credentialsText(GOOD_SECRET_B64).replace(/^\s*secret:.*$/mu, '');
    expect(() => parseSigningSecret(text)).toThrow(/secret/);
  });

  it('密钥长度不对时报错（而不是拿去签一个必被 401 的 cookie）', () => {
    const short = Buffer.from('tooshort', 'utf8').toString('base64');
    expect(() => parseSigningSecret(credentialsText(short))).toThrow(/长度异常/);
  });

  it('只在该记录窗口内找 secret，不误抓 refs 段的同名键', () => {
    const tricky = [
      'version: 1',
      'refs:',
      `  secret: ${Buffer.from('wrongwrongwrongwrongwrongwrongwr', 'utf8').toString('base64')}`,
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      `      secret: ${GOOD_SECRET_B64}`,
      '',
    ].join('\n');
    expect(parseSigningSecret(tricky).equals(GOOD_SECRET)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('signCookie —— 必须与 dsh 的算法逐字节一致', () => {
  it('cookie 名是 dsh-auth-<base64url(sha256(authority))>', () => {
    const ck = signCookie('127.0.0.1:3080', GOOD_SECRET);
    const expectedName =
      'dsh-auth-' +
      createHash('sha256').update('127.0.0.1:3080', 'utf8').digest().toString('base64')
        .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    expect(ck.name).toBe(expectedName);
  });

  it('cookie 值形如 v1.<body>.<sig>，且签名可被独立复算验证', () => {
    const ck = signCookie('127.0.0.1:3080', GOOD_SECRET);
    const parts = ck.value.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v1');

    // 解出 body 里的时间戳，再用独立实现复算整枚 cookie
    const bodyJson = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8'),
    ) as { version: number; authority: string; issuedAt: number; expiresAt: number };

    expect(bodyJson.version).toBe(1);
    expect(bodyJson.authority).toBe('127.0.0.1:3080');
    expect(bodyJson.expiresAt).toBeGreaterThan(bodyJson.issuedAt);
    // 默认寿命 1 天。**不要调大**：dsh 服务端会拒绝寿命超过其 cookieMaxAgeDays
    // 的 cookie（实测 7 天对 127.0.0.1:3080 得 401，1 天得 200）。
    expect(bodyJson.expiresAt - bodyJson.issuedAt).toBe(86_400_000);

    const expected = expectedCookie('127.0.0.1:3080', GOOD_SECRET, bodyJson);
    expect(ck.name).toBe(expected.name);
    expect(ck.value).toBe(expected.value);
  });

  it('显式传入寿命时按传入值签（便于对接不同 cookieMaxAgeDays 的实例）', () => {
    const ck = signCookie('127.0.0.1:3080', GOOD_SECRET, 3);
    const parts = ck.value.split('.');
    const bodyJson = JSON.parse(
      Buffer.from(parts[1]!.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8'),
    ) as { issuedAt: number; expiresAt: number };
    expect(bodyJson.expiresAt - bodyJson.issuedAt).toBe(3 * 86_400_000);
  });

  it('header 是可直接放进请求头的 name=value', () => {
    const ck = signCookie('127.0.0.1:1', GOOD_SECRET);
    expect(ck.header).toBe(`${ck.name}=${ck.value}`);
  });

  it('换 authority 会同时换 cookie 名与签名', () => {
    const a = signCookie('127.0.0.1:3080', GOOD_SECRET);
    const b = signCookie('127.0.0.1:13080', GOOD_SECRET);
    expect(a.name).not.toBe(b.name);
    expect(a.value).not.toBe(b.value);
  });

  it('换密钥会换签名（但 cookie 名不变，因为名只绑定 authority）', () => {
    const other = Buffer.from('ffffffffffffffffffffffffffffffff', 'utf8');
    const a = signCookie('127.0.0.1:3080', GOOD_SECRET);
    const b = signCookie('127.0.0.1:3080', other);
    expect(a.name).toBe(b.name);
    expect(a.value).not.toBe(b.value);
  });
});

// ---------------------------------------------------------------------------
describe('deriveSessionStatus —— 优先级与语义', () => {
  const NOW = 1_800_000_000_000;
  const fresh = { now: NOW, updatedAt: NOW - 10_000 } as const;

  it('pendingInteraction=approval 压过 running（最值钱的态）', () => {
    expect(
      deriveSessionStatus({ running: true, pendingInteraction: 'approval', ...fresh }),
    ).toBe('waiting');
  });

  it('三种等待类型都判 waiting', () => {
    for (const kind of ['approval', 'plan-review', 'question'] as const) {
      expect(deriveSessionStatus({ running: true, pendingInteraction: kind, ...fresh })).toBe('waiting');
    }
  });

  it('子代理在跑也算 running（即使主 agent 没在跑）', () => {
    expect(deriveSessionStatus({ running: false, runningSubagentCount: 2, ...fresh })).toBe('running');
  });

  it('主 agent 在跑 → running', () => {
    expect(deriveSessionStatus({ running: true, ...fresh })).toBe('running');
  });

  it('刚发消息（<5s）→ starting，避免闪一下 idle', () => {
    expect(deriveSessionStatus({ running: false, agentAvailable: true, now: NOW, updatedAt: NOW - 1_000 })).toBe(
      'starting',
    );
  });

  it('静默且 agent 仍在 → idle', () => {
    expect(deriveSessionStatus({ running: false, agentAvailable: true, ...fresh })).toBe('idle');
  });

  it('agent 已不在 → idle', () => {
    expect(
      deriveSessionStatus({ running: false, agentAvailable: false, now: NOW, updatedAt: NOW - 10_000 }),
    ).toBe('idle');
  });

  it('静默超时（>60s）→ idle，防灯一直是绿的', () => {
    expect(
      deriveSessionStatus({ running: false, agentAvailable: true, now: NOW, updatedAt: NOW - 120_000 }),
    ).toBe('idle');
  });

  // -------------------------------------------------------------------------
  // ★ 回归：静默判定必须**先于** running 判定
  // -------------------------------------------------------------------------
  // 用户反馈「明明都执行完成了怎么显示还是运行中」。
  // 实测抓到的真实数据：
  //   session-26c9a3ad  running=true  未结算子代理=2  静默=727s  -> 判成了 running
  // 原因：原实现把静默判定放在 running / runningSubagentCount **之后**，
  // 于是这两个标志一旦陈旧（dsh 不再更新，或 subagentCatalog 里留着
  // 永远没写 settledAt 的条目），灯就会**永远蓝色**。
  describe('★ 静默优先于 running（"执行完了还显示运行中"的根因）', () => {
    it('running=true 但静默 727s → idle（实测复现的数字）', () => {
      expect(
        deriveSessionStatus({
          running: true,
          agentAvailable: true,
          now: NOW,
          updatedAt: NOW - 727_000,
        }),
      ).toBe('idle');
    });

    it('有未结算子代理但静默超时 → idle（陈旧的 subagentCatalog 不能锁死蓝灯）', () => {
      expect(
        deriveSessionStatus({
          running: true,
          agentAvailable: true,
          runningSubagentCount: 2, // 实测就是 2
          now: NOW,
          updatedAt: NOW - 727_000,
        }),
      ).toBe('idle');
    });

    it('两个陈旧标志同时存在也压不过静默 → idle', () => {
      expect(
        deriveSessionStatus({
          running: true,
          runningSubagentCount: 5,
          agentAvailable: true,
          now: NOW,
          updatedAt: NOW - 3_600_000,
        }),
      ).toBe('idle');
    });

    it('但**刚活动过**的 running 仍然是 running（不能把活跃会话误判成 idle）', () => {
      expect(
        deriveSessionStatus({ running: true, agentAvailable: true, now: NOW, updatedAt: NOW - 2_000 }),
      ).toBe('running');
    });

    it('子代理在跑且刚有活动 → running（真实运行中不该被静默规则误伤）', () => {
      expect(
        deriveSessionStatus({
          running: true,
          runningSubagentCount: 2,
          agentAvailable: true,
          now: NOW,
          updatedAt: NOW - 30_000, // 30s < 60s 阈值
        }),
      ).toBe('running');
    });

    it('★ 静默判定不能盖过 waiting（人卡在授权上等再久也还是 waiting）', () => {
      // 这条很重要：如果用"静默即 idle"粗暴覆盖 waiting，
      // 「等你授权」这个最值钱的信号会在 60 秒后消失 —— 那是本末倒置。
      expect(
        deriveSessionStatus({
          running: true,
          pendingInteraction: 'approval',
          agentAvailable: true,
          now: NOW,
          updatedAt: NOW - 3_600_000,
        }),
      ).toBe('waiting');
    });

    it('updatedAt 缺失时不做静默判定（没有时间信息就不能假设它静默了）', () => {
      expect(
        deriveSessionStatus({ running: true, agentAvailable: true, now: NOW }),
      ).toBe('running');
    });

    it('静默阈值可配置', () => {
      const input = { running: true, agentAvailable: true, now: NOW, updatedAt: NOW - 30_000 };
      expect(deriveSessionStatus(input)).toBe('running'); // 默认 60s
      expect(deriveSessionStatus({ ...input, silenceMs: 10_000 })).toBe('idle'); // 收紧到 10s
    });

    // -----------------------------------------------------------------------
    // SPEC-004：桌面端长回合"在跑却被判空闲"
    // -----------------------------------------------------------------------
    // 桌面端 dsh 的 session/list 里 updatedAt **只在回合边界推进**，长回合中间
    // 完全不动。实测取样（2026-10-19）：running=true、agentAvailable=true、
    // updatedAt 距今 289 秒 —— 那时会话确实在跑，但 60 秒静默阈值已经把它判成
    // idle，于是灯在回合开始约 1 分钟后从蓝变灰并一直灰着。
    describe('SPEC-004 桌面端长回合：running 的静默阈值更宽', () => {
      it('AC-01 running=true 静默 289s（真机数字）→ running', () => {
        expect(
          deriveSessionStatus({ running: true, agentAvailable: true, now: NOW, updatedAt: NOW - 289_000 }),
        ).toBe('running');
      });

      it('AC-02 静默 9 分钟仍在跑 → running', () => {
        expect(
          deriveSessionStatus({ running: true, agentAvailable: true, now: NOW, updatedAt: NOW - 540_000 }),
        ).toBe('running');
      });

      it('AC-03 静默超过 10 分钟 → idle（陈旧 running 仍要防）', () => {
        expect(
          deriveSessionStatus({ running: true, agentAvailable: true, now: NOW, updatedAt: NOW - 601_000 }),
        ).toBe('idle');
      });

      it('阈值可注入：runningSilenceMs 收紧后同样的静默变 idle', () => {
        expect(
          deriveSessionStatus({
            running: true,
            agentAvailable: true,
            now: NOW,
            updatedAt: NOW - 540_000,
            runningSilenceMs: 500_000,
          }),
        ).toBe('idle');
      });
    });

    describe('SPEC-021 活信号：长回合超过 10 分钟仍保持 running', () => {
      it('AC-01 updatedAt 陈旧但活信号新鲜 → running', () => {
        expect(
          deriveSessionStatus({
            running: true,
            agentAvailable: true,
            now: NOW,
            updatedAt: NOW - 20 * 60_000,
            lastLiveSignalAt: NOW - 5_000,
          }),
        ).toBe('running');
      });

      it('AC-02 updatedAt 与活信号都陈旧 → idle（保留防常蓝）', () => {
        expect(
          deriveSessionStatus({
            running: true,
            agentAvailable: true,
            now: NOW,
            updatedAt: NOW - 20 * 60_000,
            lastLiveSignalAt: NOW - 601_000,
          }),
        ).toBe('idle');
      });

      it('AC-03 未来时间戳不能延长蓝灯 → idle', () => {
        expect(
          deriveSessionStatus({
            running: true,
            agentAvailable: true,
            now: NOW,
            updatedAt: NOW - 20 * 60_000,
            lastLiveSignalAt: NOW + 3_600_000,
          }),
        ).toBe('idle');
      });

      it('AC-03 非法的活信号时间戳被忽略 → idle', () => {
        expect(
          deriveSessionStatus({
            running: true,
            agentAvailable: true,
            now: NOW,
            updatedAt: NOW - 20 * 60_000,
            lastLiveSignalAt: Number.NaN,
          }),
        ).toBe('idle');
      });
    });
  });

  it('errorMessage 一票否决：即使同时在等授权也判 failed', () => {
    expect(
      deriveSessionStatus({
        running: true,
        pendingInteraction: 'approval',
        errorMessage: '工具执行超时',
        ...fresh,
      }),
    ).toBe('failed');
  });

  it('没有精确信号时**不**凭空判 waiting（宁可不报，也不报假黄灯）', () => {
    const s = deriveSessionStatus({ running: false, agentAvailable: true, ...fresh });
    expect(s).not.toBe('waiting');
  });
});

// ---------------------------------------------------------------------------
describe('deriveFromListItem —— 无插件时的近似路径', () => {
  const NOW = 1_800_000_000_000;

  const baseItem = {
    sessionId: 'session-x',
    updatedAt: NOW - 10_000,
    agentAvailable: true,
    running: false,
    projections: {
      values: {
        plan: { active: false, pending: false },
        subagentCatalog: [] as { id?: string; settledAt?: number }[],
      },
    },
  };

  it('plan.pending → 近似判 waiting（没有插件时的最佳可得）', () => {
    const item = { ...baseItem, projections: { values: { ...baseItem.projections.values, plan: { active: true, pending: true } } } };
    expect(deriveFromListItem(item, NOW)).toBe('waiting');
  });

  it('allowPlanPendingHeuristic=false 时不吃 plan.pending（保守模式）', () => {
    const item = { ...baseItem, projections: { values: { ...baseItem.projections.values, plan: { active: true, pending: true } } } };
    expect(deriveFromListItem(item, NOW, { allowPlanPendingHeuristic: false })).toBe('idle');
  });

  it('未结算的子代理计入 runningSubagentCount', () => {
    const item = {
      ...baseItem,
      projections: {
        values: {
          ...baseItem.projections.values,
          subagentCatalog: [{ id: 'a' }, { id: 'b', settledAt: NOW }, { id: 'c' }],
        },
      },
    };
    // 2 个未结算 → running
    expect(deriveFromListItem(item, NOW)).toBe('running');
  });

  it('全部子代理已结算 → 不计入，回落 idle', () => {
    const item = {
      ...baseItem,
      projections: {
        values: { ...baseItem.projections.values, subagentCatalog: [{ id: 'a', settledAt: NOW }] },
      },
    };
    expect(deriveFromListItem(item, NOW)).toBe('idle');
  });

  it('★ 不接收插件精确信号 —— 精确合并归 mergeExactIntoPolled 负责', () => {
    // 设计约束：本函数只产出「轮询侧」结论。
    // 插件的 pendingInteraction 若混进来，就会绕过
    // mergeExactIntoPolled 里「轮询已判 failed 时不许被 waiting 覆盖」的保护。
    // 这里用"多传一个插件状态对象"来验证它不会被误当成 now 参数使用。
    const item = { ...baseItem, running: false, projections: { values: { plan: { active: false, pending: false }, subagentCatalog: [] } } };
    // 第三个参数是 options，不是插件状态
    expect(deriveFromListItem(item, NOW, {})).toBe('idle');
  });

  it('字段缺失也不崩（防御式）', () => {
    expect(() => deriveFromListItem({}, NOW)).not.toThrow();
    expect(deriveFromListItem({}, NOW)).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// RPC 线协议：起一个真实本地 HTTP 服务
// ---------------------------------------------------------------------------
describe('DshClient.call —— 线协议与失败分类', () => {
  let server: Server;
  let authority: string;
  /** 最近一次收到的请求，供断言形状。 */
  let lastRequest: { url?: string; method?: string; body?: unknown; cookie?: string } = {};

  /** 每个用例前设置的行为。 */
  let behaviour: (req: { body: unknown }) => { status: number; json?: unknown; text?: string } = () => ({
    status: 200,
    json: {},
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += String(c);
      });
      req.on('end', () => {
        lastRequest = {
          url: req.url,
          method: req.method,
          body: raw ? JSON.parse(raw) : undefined,
          cookie: req.headers.cookie,
        };
        const out = behaviour({ body: lastRequest.body });
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? ''));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    authority = `127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** 造一个成功响应，rpcId 回带请求里的那个。 */
  const okResponse = (reqBody: unknown, value: unknown) => ({
    status: 200,
    json: {
      type: 'server-response',
      rpcId: (reqBody as { rpcId?: string }).rpcId,
      result: { ok: true, value },
    },
  });

  it('请求形状正确：POST /api/<endpoint>，body 是 client-request 信封，带 cookie', async () => {
    behaviour = ({ body }) => okResponse(body, { items: [] });

    const client = new DshClient({ authority, secret: GOOD_SECRET });
    const result = await client.listSessions();

    expect(result.ok).toBe(true);
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.url).toBe('/api/session/list');

    const sent = lastRequest.body as Record<string, unknown>;
    expect(sent['type']).toBe('client-request');
    expect(sent['method']).toBe('session/list');
    expect(typeof sent['rpcId']).toBe('string');
    // args 形状：session/list 用的是 _request
    expect(sent['payload']).toEqual({ args: { _request: {} } });
    expect(lastRequest.cookie).toMatch(/^dsh-auth-/u);
  });

  it('rpcId 不回带一致时判为串包，不当作成功', async () => {
    behaviour = () => ({
      status: 200,
      json: { type: 'server-response', rpcId: 'someone-elses-id', result: { ok: true, value: {} } },
    });

    const client = new DshClient({ authority, secret: GOOD_SECRET });
    const result = await client.call('session/list', { _request: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('protocol/rpc-id-mismatch');
  });

  it('401 被单独分类为 auth/unauthorized（提示可能是远端实例）', async () => {
    behaviour = () => ({ status: 401, text: 'unauthorized' });
    const client = new DshClient({ authority, secret: GOOD_SECRET });
    const result = await client.call('session/list', { _request: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('auth/unauthorized');
      expect(result.message).toMatch(/密钥/);
    }
  });

  it('403 被分类为 auth/forbidden', async () => {
    behaviour = () => ({ status: 403, text: 'forbidden' });
    const client = new DshClient({ authority, secret: GOOD_SECRET });
    const result = await client.call('session/list', { _request: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('auth/forbidden');
  });

  it('响应不是合法 JSON → protocol/bad-json，不崩', async () => {
    behaviour = () => ({ status: 200, text: 'not json at all' });
    const client = new DshClient({ authority, secret: GOOD_SECRET });
    const result = await client.call('session/list', { _request: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('protocol/bad-json');
  });

  it('网关层 arguments-invalid 被识别出来（参数形状写错时会看到它）', async () => {
    behaviour = ({ body }) => ({
      status: 200,
      json: {
        type: 'server-response',
        rpcId: (body as { rpcId?: string }).rpcId,
        result: {
          ok: false,
          error: { code: 'gateway/arguments-invalid', message: 'args fields do not match' },
        },
      },
    });

    const client = new DshClient({ authority, secret: GOOD_SECRET });
    const result = await client.call('session/list', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('protocol/arguments-invalid');
      expect(result.message).toMatch(/gateway\/arguments-invalid/);
    }
  });

  it('连不上时判 transport/unreachable，不抛错', async () => {
    // 一个必然拒绝连接的地址
    const client = new DshClient({ authority: '127.0.0.1:1', secret: GOOD_SECRET, timeoutMs: 2_000 });
    const result = await client.call('session/list', { _request: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('transport/unreachable');
  });

  it('session/projections 用的是 request 形状（两种 args 风格并存，不可猜）', async () => {
    behaviour = ({ body }) => okResponse(body, { values: {} });
    const client = new DshClient({ authority, secret: GOOD_SECRET });
    await client.sessionProjections('session-abc');

    expect(lastRequest.url).toBe('/api/session/projections');
    expect((lastRequest.body as { payload: unknown }).payload).toEqual({
      args: { request: { sessionId: 'session-abc' } },
    });
  });
});

// ---------------------------------------------------------------------------
describe('DshClient.probe', () => {
  let server: Server;
  let authority: string;
  let lastCookie: string | undefined;
  let respond: () => { status: number; body: string } = () => ({ status: 200, body: '' });

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastCookie = req.headers.cookie;
      const out = respond();
      res.writeHead(out.status, { 'content-type': 'text/html' });
      res.end(out.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('探活必须带 cookie —— 否则永远 401，会把本机实例误判成远端', async () => {
    respond = () => ({ status: 200, body: `<html>${DSH_HTML_MARKERS[0]}</html>` });
    const client = new DshClient({ authority, secret: GOOD_SECRET });
    const probe = await client.probe();

    expect(lastCookie).toMatch(/^dsh-auth-/u);
    expect(probe.isDshWeb).toBe(true);
    expect(probe.status).toBe(200);
  });

  it('401 仍判为 dsh web（那条文案是 dsh 自己写的，是强特征），但未认证', async () => {
    respond = () => ({ status: 401, body: 'dsh web authentication required; reopen the URL printed by dsh web.' });
    const client = new DshClient({ authority, secret: GOOD_SECRET });
    const probe = await client.probe();

    expect(probe.isDshWeb).toBe(true);
    expect(probe.status).toBe(401);
    expect(probe.hint).toMatch(/authentication required/u);
  });

  it('200 但页面没有 dsh 特征 → 判为非 dsh（避免把别的服务误认）', async () => {
    respond = () => ({ status: 200, body: '<html><title>Some Other Service</title></html>' });
    const client = new DshClient({ authority, secret: GOOD_SECRET });
    const probe = await client.probe();

    expect(probe.isDshWeb).toBe(false);
    expect(probe.status).toBe(200);
  });

  it('不可达时不抛错', async () => {
    const client = new DshClient({ authority: '127.0.0.1:1', secret: GOOD_SECRET });
    const probe = await client.probe();
    expect(probe.reachable).toBe(false);
  });
});
