import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Save,
  Search,
} from 'lucide-react';
import { getParsedApiError } from '../../api/error';
import { systemConfigApi } from '../../api/systemConfig';
import type {
  SearchTestProvider,
  SystemConfigItem,
  SystemConfigUpdateItem,
  TestSearchProviderResponse,
} from '../../types/systemConfig';

type Props = {
  items: SystemConfigItem[];
  configVersion: string;
  maskToken: string;
  onSaved: (updatedItems: SystemConfigUpdateItem[]) => Promise<void> | void;
  disabled?: boolean;
};

type SearchField = {
  provider: SearchTestProvider;
  key: string;
  label: string;
  role: string;
  description: string;
  placeholder: string;
  signupUrl?: string;
  secret: boolean;
};

const PRIMARY_FIELDS: SearchField[] = [
  {
    provider: 'bocha',
    key: 'BOCHA_API_KEYS',
    label: 'Bocha 博查搜索',
    role: '首选 / 中文 A 股',
    description: '中文网页与财经内容覆盖更适合 A 股分析。支持用逗号填写多个 Key。',
    placeholder: '填写 Bocha API Key',
    signupUrl: 'https://open.bocha.cn/',
    secret: true,
  },
  {
    provider: 'tavily',
    key: 'TAVILY_API_KEYS',
    label: 'Tavily Search',
    role: '备用 / 免费额度',
    description: 'Bocha 没有结果或暂时不可用时自动接替。支持用逗号填写多个 Key。',
    placeholder: '填写 Tavily API Key',
    signupUrl: 'https://app.tavily.com/',
    secret: true,
  },
  {
    provider: 'searxng',
    key: 'SEARXNG_BASE_URLS',
    label: 'SearXNG 自建实例',
    role: '最后兜底 / 无 API 配额',
    description: '填写自己的实例地址，并在 settings.yml 中启用 JSON 输出。多个地址用逗号分隔。',
    placeholder: 'https://search.example.com',
    secret: false,
  },
];

const EXTRA_FIELDS: SearchField[] = [
  {
    provider: 'brave',
    key: 'BRAVE_API_KEYS',
    label: 'Brave Search',
    role: '附加备用',
    description: '全球网页覆盖较好，在主渠道失败时继续降级。',
    placeholder: '填写 Brave Search API Key',
    signupUrl: 'https://api-dashboard.search.brave.com/',
    secret: true,
  },
  {
    provider: 'serpapi',
    key: 'SERPAPI_API_KEYS',
    label: 'SerpAPI',
    role: '附加备用',
    description: '搜索结果页聚合渠道，适合作为补充。',
    placeholder: '填写 SerpAPI Key',
    signupUrl: 'https://serpapi.com/',
    secret: true,
  },
];

const CONFIG_KEYS = [
  ...PRIMARY_FIELDS.map((field) => field.key),
  ...EXTRA_FIELDS.map((field) => field.key),
  'SEARXNG_PUBLIC_INSTANCES_ENABLED',
];

function initialDraft(items: SystemConfigItem[]): Record<string, string> {
  const map = Object.fromEntries(items.map((item) => [item.key, item.value]));
  return Object.fromEntries(CONFIG_KEYS.map((key) => [key, map[key] ?? '']));
}

export function NewsSearchSettings({ items, configVersion, maskToken, onSaved, disabled = false }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>(() => initialDraft(items));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [testing, setTesting] = useState<SearchTestProvider | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<SearchTestProvider, TestSearchProviderResponse>>>({});

  useEffect(() => {
    setDraft(initialDraft(items));
  }, [items]);

  const original = useMemo(() => initialDraft(items), [items]);
  const hasChanges = CONFIG_KEYS.some((key) => (draft[key] ?? '') !== (original[key] ?? ''));
  const publicInstancesEnabled = (draft.SEARXNG_PUBLIC_INSTANCES_ENABLED || 'false').toLowerCase() === 'true';

  const updateItems = (): SystemConfigUpdateItem[] => CONFIG_KEYS.map((key) => ({
    key,
    value: draft[key] ?? '',
  }));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const submitted = updateItems();
      const validation = await systemConfigApi.validate({ items: submitted });
      const errors = validation.issues.filter((issue) => issue.severity === 'error');
      if (!validation.valid || errors.length > 0) {
        setMessage({ kind: 'error', text: errors[0]?.message || '配置校验失败，请检查输入内容。' });
        return;
      }
      await systemConfigApi.update({
        configVersion,
        maskToken,
        reloadNow: true,
        items: submitted,
      });
      await onSaved(submitted);
      setMessage({ kind: 'success', text: '新闻搜索配置已保存，后续分析将使用新的渠道顺序。' });
    } catch (error: unknown) {
      setMessage({ kind: 'error', text: getParsedApiError(error).message || '保存失败，请稍后重试。' });
    } finally {
      setSaving(false);
    }
  };

  const testProvider = async (provider: SearchTestProvider) => {
    setTesting(provider);
    setMessage(null);
    try {
      const result = await systemConfigApi.testSearchProvider({
        provider,
        items: updateItems(),
        maskToken,
      });
      setTestResults((current) => ({ ...current, [provider]: result }));
    } catch (error: unknown) {
      setTestResults((current) => ({
        ...current,
        [provider]: {
          success: false,
          provider,
          message: getParsedApiError(error).message || '连接测试失败',
          resultCount: 0,
          retryable: true,
        },
      }));
    } finally {
      setTesting(null);
    }
  };

  const renderField = (field: SearchField) => {
    const result = testResults[field.provider];
    const configured = Boolean((draft[field.key] || '').trim());
    return (
      <div key={field.key} className="border-t border-border/60 py-5 first:border-t-0 first:pt-0 last:pb-0">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 lg:max-w-[42%]">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium text-foreground">{field.label}</h3>
              <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{field.role}</span>
              <span className={`text-xs ${configured ? 'text-success' : 'text-muted-text'}`}>{configured ? '已配置' : '未配置'}</span>
            </div>
            <p className="mt-1.5 text-sm leading-6 text-muted-text">{field.description}</p>
            {field.signupUrl ? (
              <a className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline" href={field.signupUrl} target="_blank" rel="noreferrer">
                申请 API Key <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
          <div className="w-full min-w-0 lg:max-w-[54%]">
            <label className="mb-1.5 block text-xs font-medium text-muted-text" htmlFor={`search-setting-${field.key}`}>{field.secret ? 'API Key' : '实例地址'}</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id={`search-setting-${field.key}`}
                type={field.secret ? 'password' : 'text'}
                className="input-surface min-w-0 flex-1 rounded-xl px-3 py-2.5 text-sm"
                value={draft[field.key] ?? ''}
                placeholder={field.placeholder}
                disabled={disabled || saving}
                autoComplete="off"
                onChange={(event) => {
                  setDraft((current) => ({ ...current, [field.key]: event.target.value }));
                  setTestResults((current) => ({ ...current, [field.provider]: undefined }));
                }}
              />
              <button
                type="button"
                className="btn-secondary shrink-0 justify-center sm:w-24"
                disabled={disabled || saving || testing !== null}
                onClick={() => void testProvider(field.provider)}
              >
                {testing === field.provider ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                测试
              </button>
            </div>
            {result ? (
              <p className={`mt-2 flex items-start gap-1.5 text-xs ${result.success ? 'text-success' : 'text-danger'}`} role="status">
                {result.success ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                <span>{result.message}{result.latencyMs != null ? `，${result.latencyMs} ms` : ''}</span>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-border/70 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Search className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">新闻搜索 API</h2>
          </div>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-text">按 Bocha、Tavily、Brave、SerpAPI、SearXNG 的既有顺序自动降级。这里只配置数据来源，不改变分析策略和评分规则。</p>
        </div>
        <button
          type="button"
          className="settings-button-primary inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || saving || !hasChanges}
          onClick={() => void save()}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? '正在保存' : '保存新闻搜索配置'}
        </button>
      </div>

      <div>{PRIMARY_FIELDS.map(renderField)}</div>

      <details className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">其他备用渠道</summary>
        <div className="mt-4">{EXTRA_FIELDS.map(renderField)}</div>
      </details>

      <div className={`rounded-xl border p-4 ${publicInstancesEnabled ? 'border-warning/35 bg-warning/10' : 'border-border/60 bg-muted/20'}`}>
        <label className="flex cursor-pointer items-start justify-between gap-4" htmlFor="search-setting-public-searxng">
          <span>
            <span className="block text-sm font-medium text-foreground">允许自动使用公共 SearXNG 实例</span>
            <span className="mt-1 block text-xs leading-5 text-muted-text">不推荐。公共实例近期经常出现限流、验证页和超时，开启后可能明显拉长单股分析时间。自建实例不受此开关影响。</span>
          </span>
          <input
            id="search-setting-public-searxng"
            type="checkbox"
            className="settings-input-checkbox mt-1 h-4 w-4 shrink-0"
            checked={publicInstancesEnabled}
            disabled={disabled || saving}
            onChange={(event) => setDraft((current) => ({
              ...current,
              SEARXNG_PUBLIC_INSTANCES_ENABLED: event.target.checked ? 'true' : 'false',
            }))}
          />
        </label>
      </div>

      {message ? (
        <p className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm ${message.kind === 'success' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`} role="status">
          {message.kind === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
