/**
 * OpenCLI 公共 API 工具集
 *
 * 将 OpenCLI 项目中 strategy=public 且 browser=false 的命令，
 * 封装为 WorkerClaw 内置工具，让 Agent 可以直接调用公开 API 获取数据。
 *
 * 所有工具权限级别为 limited（只读网络请求，不修改数据）。
 *
 * 支持的 site 命令：
 *   - hackernews: top, new, best, ask, show, jobs, search
 *   - stackoverflow: hot, search
 *   - devto: top, tag
 *   - lobsters: hot, newest, active
 *   - v2ex: hot, latest
 *   - reddit: hot, popular, frontpage, search
 *   - producthunt: today, hot
 *   - steam: top-sellers
 *   - reuters: search
 *   - bbc: news
 *   - arxiv: search, paper
 *   - hf (HuggingFace): top
 *   - dictionary: search, synonyms, examples
 *   - wikipedia: search, summary, trending, random
 *   - google: search, news, trends, suggest
 *   - bloomberg: news, markets, tech, politics, economics
 *   - imdb: search, trending, top
 *   - 36kr: hot, news, article, search
 *   - smzdm: search
 *   - sinafinance: news, stock, rolling-news
 *   - xueqiu: hot, hot-stock, search, stock, feed
 *   - weibo: hot_search, search (通过 web_cli 代理还可调用: post, retweet, comment, like, profile)
 *   - zhihu: hot, search, profile, question (通过 web_cli 代理还可调用: article, answer, comment)
 *   - xiaohongshu: hot, search, note, comments, profile (通过 web_cli 代理还可调用: publish)
 */

import { createLogger } from '../core/logger.js';
import type { ToolDefinition, ToolExecutorFn, ToolResult, PermissionLevel } from '../types/agent.js';

const logger = createLogger('OpenCliTools');

// ==================== 工具定义注册表 ====================

interface OpenCliToolDef {
  name: string;
  description: string;
  site: string;
  command: string;
  args: Record<string, { type: 'string' | 'number'; required?: boolean; default?: any; description: string }>;
  execute: (args: Record<string, any>) => Promise<string>;
}

// 所有 PUBLIC API 工具定义
const OPENCLI_TOOLS: OpenCliToolDef[] = [
  // === Hacker News ===
  {
    name: 'hackernews_top',
    description: '获取 Hacker News 首页热门帖子（Top Stories）',
    site: 'hackernews', command: 'top',
    args: { limit: { type: 'number', default: 20, description: '返回条数（默认20）' } },
    execute: async (args) => fetchHackerNews('top', args),
  },
  {
    name: 'hackernews_new',
    description: '获取 Hacker News 最新帖子',
    site: 'hackernews', command: 'new',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchHackerNews('new', args),
  },
  {
    name: 'hackernews_best',
    description: '获取 Hacker News 最佳帖子',
    site: 'hackernews', command: 'best',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchHackerNews('best', args),
  },
  {
    name: 'hackernews_ask',
    description: '获取 Hacker News Ask HN 帖子',
    site: 'hackernews', command: 'ask',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchHackerNews('ask', args),
  },
  {
    name: 'hackernews_show',
    description: '获取 Hacker News Show HN 帖子',
    site: 'hackernews', command: 'show',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchHackerNews('show', args),
  },
  {
    name: 'hackernews_jobs',
    description: '获取 Hacker News 招聘帖子',
    site: 'hackernews', command: 'jobs',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchHackerNews('jobs', args),
  },
  {
    name: 'hackernews_search',
    description: '搜索 Hacker News 帖子',
    site: 'hackernews', command: 'search',
    args: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      limit: { type: 'number', default: 20, description: '返回条数' },
      sort: { type: 'string', default: 'relevance', description: '排序方式: relevance 或 date' },
    },
    execute: async (args) => searchHackerNews(args),
  },

  // === Stack Overflow ===
  {
    name: 'stackoverflow_hot',
    description: '获取 Stack Overflow 热门问题',
    site: 'stackoverflow', command: 'hot',
    args: { limit: { type: 'number', default: 10, description: '返回条数' } },
    execute: async (args) => fetchStackOverflowHot(args),
  },
  {
    name: 'stackoverflow_search',
    description: '搜索 Stack Overflow 问答',
    site: 'stackoverflow', command: 'search',
    args: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      limit: { type: 'number', default: 10, description: '返回条数' },
    },
    execute: async (args) => searchStackOverflow(args),
  },

  // === DEV.to ===
  {
    name: 'devto_top',
    description: '获取 DEV.to 热门文章',
    site: 'devto', command: 'top',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchDevToTop(args),
  },
  {
    name: 'devto_tag',
    description: '获取 DEV.to 指定标签的文章',
    site: 'devto', command: 'tag',
    args: {
      tag: { type: 'string', required: true, description: '标签名（如 javascript, rust）' },
      limit: { type: 'number', default: 20, description: '返回条数' },
    },
    execute: async (args) => fetchDevToTag(args),
  },

  // === Lobsters ===
  {
    name: 'lobsters_hot',
    description: '获取 Lobste.rs 热门技术文章',
    site: 'lobsters', command: 'hot',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchLobsters('hottest.json', args),
  },
  {
    name: 'lobsters_newest',
    description: '获取 Lobste.rs 最新技术文章',
    site: 'lobsters', command: 'newest',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchLobsters('newest.json', args),
  },
  {
    name: 'lobsters_active',
    description: '获取 Lobste.rs 活跃讨论',
    site: 'lobsters', command: 'active',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchLobsters('active.json', args),
  },

  // === V2EX ===
  {
    name: 'v2ex_hot',
    description: '获取 V2EX 热门话题',
    site: 'v2ex', command: 'hot',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchV2EX('hot.json', args),
  },
  {
    name: 'v2ex_latest',
    description: '获取 V2EX 最新话题',
    site: 'v2ex', command: 'latest',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchV2EX('latest.json', args),
  },

  // === Reddit ===
  {
    name: 'reddit_hot',
    description: '获取 Reddit 热门帖子（指定 subreddit）',
    site: 'reddit', command: 'hot',
    args: {
      subreddit: { type: 'string', default: 'all', description: 'Subreddit 名称（如 programming, all）' },
      limit: { type: 'number', default: 20, description: '返回条数' },
    },
    execute: async (args) => fetchReddit('hot', args),
  },
  {
    name: 'reddit_search',
    description: '搜索 Reddit 帖子',
    site: 'reddit', command: 'search',
    args: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      subreddit: { type: 'string', default: 'all', description: '在哪个 subreddit 搜索' },
      limit: { type: 'number', default: 20, description: '返回条数' },
    },
    execute: async (args) => searchReddit(args),
  },

  // === Product Hunt ===
  {
    name: 'producthunt_today',
    description: '获取 Product Hunt 今日热门产品',
    site: 'producthunt', command: 'today',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchProductHuntToday(args),
  },

  // === Steam ===
  {
    name: 'steam_top_sellers',
    description: '获取 Steam 畅销游戏榜',
    site: 'steam', command: 'top-sellers',
    args: { limit: { type: 'number', default: 10, description: '返回条数' } },
    execute: async (args) => fetchSteamTopSellers(args),
  },

  // === ArXiv ===
  {
    name: 'arxiv_search',
    description: '搜索 ArXiv 学术论文',
    site: 'arxiv', command: 'search',
    args: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      limit: { type: 'number', default: 10, description: '返回条数' },
    },
    execute: async (args) => searchArxiv(args),
  },

  // === HuggingFace ===
  {
    name: 'hf_trending',
    description: '获取 HuggingFace 热门模型',
    site: 'hf', command: 'top',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchHFTrending(args),
  },

  // === Wikipedia ===
  {
    name: 'wikipedia_search',
    description: '搜索 Wikipedia 条目',
    site: 'wikipedia', command: 'search',
    args: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      limit: { type: 'number', default: 10, description: '返回条数' },
    },
    execute: async (args) => searchWikipedia(args),
  },
  {
    name: 'wikipedia_summary',
    description: '获取 Wikipedia 条目摘要',
    site: 'wikipedia', command: 'summary',
    args: {
      title: { type: 'string', required: true, description: '条目标题' },
    },
    execute: async (args) => fetchWikipediaSummary(args),
  },
  {
    name: 'wikipedia_trending',
    description: '获取 Wikipedia 当前热门条目',
    site: 'wikipedia', command: 'trending',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetchWikipediaTrending(args),
  },

  // === 36kr ===
  {
    name: 'kr36_hot',
    description: '获取 36氪热门资讯',
    site: '36kr', command: 'hot',
    args: { limit: { type: 'number', default: 20, description: '返回条数' } },
    execute: async (args) => fetch36KrHot(args),
  },

  // === 微博热搜 ===
  {
    name: 'weibo_hot_search',
    description: '获取微博热搜榜（公开数据，可用于结合热搜话题生成推广文案）',
    site: 'weibo', command: 'hot_search',
    args: {
      limit: { type: 'number', default: 20, description: '返回条数' },
      category: { type: 'string', default: 'realtime', description: '分类: all=全部, realtime=实时, hot=热门, social=社会, ent=娱乐, finance=财经' },
    },
    execute: async (args) => fetchWeiboHotSearch(args),
  },

  // === 微博搜索 ===
  {
    name: 'weibo_search',
    description: '搜索微博内容（公开搜索，不需要登录）',
    site: 'weibo', command: 'search',
    args: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      limit: { type: 'number', default: 10, description: '返回条数' },
    },
    execute: async (args) => searchWeibo(args),
  },
];

// ==================== 通用 HTTP fetch ====================

const USER_AGENT = 'Mozilla/5.0 (compatible; WorkerClaw/1.0; +https://www.miniabc.top)';
const DEFAULT_TIMEOUT = 15000;

async function httpGet(url: string, timeoutMs = DEFAULT_TIMEOUT): Promise<any> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

// ==================== 格式化输出 ====================

function formatResults(items: Record<string, any>[], columns: string[]): string {
  if (!items || items.length === 0) return '暂无数据';
  return items.map((item, i) => {
    const parts = columns.map(col => {
      const val = item[col];
      if (val === undefined || val === null) return '';
      const str = String(val);
      // URL 类型单独标记
      if (col === 'url' && str.startsWith('http')) return '';
      return `${col}: ${str}`;
    }).filter(Boolean);

    const rank = `[${i + 1}]`;
    const url = item.url ? `\n   链接: ${item.url}` : '';
    return `${rank} ${parts.join(' | ')}${url}`;
  }).join('\n');
}

// ==================== Hacker News ====================

const HN_API = 'https://hacker-news.firebaseio.com/v0';

async function fetchHackerNews(type: string, args: Record<string, any>): Promise<string> {
  const limit = Math.min(args.limit || 20, 50);
  const ids = await httpGet(`${HN_API}/${type}stories.json`) as number[];

  const items = [];
  const fetchLimit = Math.min(limit + 5, ids.length);
  for (let i = 0; i < fetchLimit; i++) {
    try {
      const item = await httpGet(`${HN_API}/item/${ids[i]}.json`);
      if (item && item.title && !item.deleted && !item.dead) {
        items.push({
          title: item.title,
          score: item.score || 0,
          author: item.by || '',
          comments: item.descendants || 0,
          url: item.url || `https://news.ycombinator.com/item?id=${ids[i]}`,
        });
      }
    } catch { /* skip failed items */ }
    if (items.length >= limit) break;
  }

  return `Hacker News ${type} stories (${items.length}条):\n\n${formatResults(items, ['title', 'score', 'author', 'comments'])}`;
}

async function searchHackerNews(args: Record<string, any>): Promise<string> {
  const sort = args.sort === 'date' ? 'search_by_date' : 'search';
  const url = `https://hn.algolia.com/api/v1/${sort}?query=${encodeURIComponent(args.query)}&tags=story&hitsPerPage=${Math.min(args.limit || 20, 50)}`;
  const data = await httpGet(url);
  const hits = (data.hits || []).map((h: any) => ({
    title: h.title,
    score: h.points || 0,
    author: h.author || '',
    comments: h.num_comments || 0,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
  }));

  return `Hacker News 搜索 "${args.query}" (${hits.length}条):\n\n${formatResults(hits, ['title', 'score', 'author', 'comments', 'url'])}`;
}

// ==================== Stack Overflow ====================

async function fetchStackOverflowHot(args: Record<string, any>): Promise<string> {
  const url = `https://api.stackexchange.com/2.3/questions?order=desc&sort=hot&site=stackoverflow&pagesize=${Math.min(args.limit || 10, 50)}`;
  const data = await httpGet(url);
  const items = (data.items || []).map((q: any) => ({
    title: q.title,
    score: q.score,
    answers: q.answer_count,
    tags: (q.tags || []).join(', '),
    url: q.link,
  }));

  return `Stack Overflow 热门问题 (${items.length}条):\n\n${formatResults(items, ['title', 'score', 'answers', 'tags', 'url'])}`;
}

async function searchStackOverflow(args: Record<string, any>): Promise<string> {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(args.query)}&site=stackoverflow&pagesize=${Math.min(args.limit || 10, 50)}`;
  const data = await httpGet(url);
  const items = (data.items || []).map((q: any) => ({
    title: q.title,
    score: q.score,
    answers: q.answer_count,
    tags: (q.tags || []).slice(0, 5).join(', '),
    url: q.link,
  }));

  return `Stack Overflow 搜索 "${args.query}" (${items.length}条):\n\n${formatResults(items, ['title', 'score', 'answers', 'tags', 'url'])}`;
}

// ==================== DEV.to =================

async function fetchDevToTop(args: Record<string, any>): Promise<string> {
  const url = `https://dev.to/api/articles?top=1&per_page=${Math.min(args.limit || 20, 50)}`;
  const articles = await httpGet(url);
  const items = (articles || []).map((a: any) => ({
    title: a.title,
    author: a.user?.username || '',
    reactions: a.public_reactions_count || 0,
    comments: a.comments_count || 0,
    tags: (a.tag_list || []).join(', '),
    url: a.url,
  }));

  return `DEV.to 热门文章 (${items.length}条):\n\n${formatResults(items, ['title', 'author', 'reactions', 'comments', 'tags', 'url'])}`;
}

async function fetchDevToTag(args: Record<string, any>): Promise<string> {
  const url = `https://dev.to/api/articles?tag=${encodeURIComponent(args.tag)}&per_page=${Math.min(args.limit || 20, 50)}`;
  const articles = await httpGet(url);
  const items = (articles || []).map((a: any) => ({
    title: a.title,
    author: a.user?.username || '',
    reactions: a.public_reactions_count || 0,
    comments: a.comments_count || 0,
    url: a.url,
  }));

  return `DEV.to #${args.tag} 文章 (${items.length}条):\n\n${formatResults(items, ['title', 'author', 'reactions', 'comments', 'url'])}`;
}

// ==================== Lobsters ===

async function fetchLobsters(endpoint: string, args: Record<string, any>): Promise<string> {
  const url = `https://lobste.rs/${endpoint}`;
  const stories = await httpGet(url);
  const items = (stories || []).slice(0, args.limit || 20).map((s: any, i: number) => ({
    title: s.title,
    score: s.score,
    author: s.submitter_user,
    comments: s.comment_count,
    tags: (s.tags || []).join(', '),
    url: s.comments_url || s.url,
  }));

  return `Lobste.rs 热门文章 (${items.length}条):\n\n${formatResults(items, ['title', 'score', 'author', 'comments', 'tags', 'url'])}`;
}

// ==================== V2EX ===

async function fetchV2EX(endpoint: string, args: Record<string, any>): Promise<string> {
  const url = `https://www.v2ex.com/api/topics/${endpoint}`;
  const topics = await httpGet(url);
  const items = (topics || []).slice(0, args.limit || 20).map((t: any, i: number) => ({
    title: t.title,
    node: t.node?.title || t.node?.name || '',
    replies: t.replies,
    url: t.url,
  }));

  return `V2EX 话题 (${items.length}条):\n\n${formatResults(items, ['title', 'node', 'replies', 'url'])}`;
}

// ==================== Reddit ===

async function fetchReddit(sort: string, args: Record<string, any>): Promise<string> {
  const sub = args.subreddit || 'all';
  const limit = Math.min(args.limit || 20, 50);
  const url = `https://www.reddit.com/r/${sub}/${sort}.json?limit=${limit}`;
  const data = await httpGet(url);
  const children = data?.data?.children || [];
  const items = children.map((c: any) => ({
    title: c.data?.title || '',
    score: c.data?.score || 0,
    author: c.data?.author || '',
    comments: c.data?.num_comments || 0,
    subreddit: c.data?.subreddit || sub,
    url: `https://www.reddit.com${c.data?.permalink || ''}`,
  }));

  return `Reddit r/${sub} ${sort} (${items.length}条):\n\n${formatResults(items, ['title', 'score', 'author', 'comments', 'subreddit', 'url'])}`;
}

async function searchReddit(args: Record<string, any>): Promise<string> {
  const sub = args.subreddit || 'all';
  const limit = Math.min(args.limit || 20, 50);
  const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(args.query)}&limit=${limit}&sort=relevance`;
  const data = await httpGet(url);
  const children = data?.data?.children || [];
  const items = children.map((c: any) => ({
    title: c.data?.title || '',
    score: c.data?.score || 0,
    author: c.data?.author || '',
    comments: c.data?.num_comments || 0,
    url: `https://www.reddit.com${c.data?.permalink || ''}`,
  }));

  return `Reddit 搜索 "${args.query}" r/${sub} (${items.length}条):\n\n${formatResults(items, ['title', 'score', 'author', 'comments', 'url'])}`;
}

// ==================== Product Hunt ===

async function fetchProductHuntToday(args: Record<string, any>): Promise<string> {
  const limit = Math.min(args.limit || 20, 50);
  const url = 'https://www.producthunt.com/feed';
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  });
  const text = await response.text();

  // 解析 Atom feed
  const items: { name: string; tagline: string; url: string }[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(text)) !== null && items.length < limit) {
    const entry = match[1];
    const titleMatch = entry.match(/<title[^>]*><!\[CDATA\[(.+?)\]\]><\/title>/);
    const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/);
    const contentMatch = entry.match(/<content[^>]*><!\[CDATA\[(.+?)\]\]><\/content>/);
    if (titleMatch && linkMatch) {
      items.push({
        name: titleMatch[1],
        tagline: contentMatch ? contentMatch[1].slice(0, 100) : '',
        url: linkMatch[1],
      });
    }
  }

  const formatted = items.slice(0, limit).map((item, i) =>
    `[${i + 1}] ${item.name}${item.tagline ? ' — ' + item.tagline : ''}\n   链接: ${item.url}`
  ).join('\n');

  return `Product Hunt 今日热门 (${items.length}条):\n\n${formatted}`;
}

// ==================== Steam =================

async function fetchSteamTopSellers(args: Record<string, any>): Promise<string> {
  const url = 'https://store.steampowered.com/api/featuredcategories/';
  const data = await httpGet(url);
  const games = data?.top_sellers?.items || [];
  const items = games.slice(0, args.limit || 10).map((g: any, i: number) => {
    const price = g.final_price ? (g.final_price / 100).toFixed(2) : '免费';
    return {
      name: g.name,
      price: `¥${price}`,
      discount: g.discount_percent ? `-${g.discount_percent}%` : '',
      url: `https://store.steampowered.com/app/${g.id}`,
    };
  });

  return `Steam 畅销榜 (${items.length}条):\n\n${formatResults(items, ['name', 'price', 'discount', 'url'])}`;
}

// ==================== ArXiv =================

async function searchArxiv(args: Record<string, any>): Promise<string> {
  const limit = Math.min(args.limit || 10, 30);
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(args.query)}&start=0&max_results=${limit}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  });
  const text = await response.text();

  const items: { title: string; authors: string; summary: string; url: string }[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(text)) !== null && items.length < limit) {
    const entry = match[1];
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const idMatch = entry.match(/<id>(.*?)<\/id>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const authorMatches = entry.matchAll(/<name>(.*?)<\/name>/g);
    const authors: string[] = [];
    for (const am of authorMatches) {
      authors.push(am[1]);
      if (authors.length >= 3) break;
    }
    const authorStr = authors.join(', ') + (authors.length >= 3 ? ' 等' : '');
    if (titleMatch && idMatch) {
      items.push({
        title: titleMatch[1].replace(/\s+/g, ' ').trim(),
        authors: authorStr,
        summary: summaryMatch ? summaryMatch[1].replace(/\s+/g, ' ').trim().slice(0, 200) : '',
        url: idMatch[1],
      });
    }
  }

  const formatted = items.map((item, i) =>
    `[${i + 1}] ${item.title}\n   作者: ${item.authors}\n   摘要: ${item.summary}...\n   链接: ${item.url}`
  ).join('\n\n');

  return `ArXiv 搜索 "${args.query}" (${items.length}条):\n\n${formatted}`;
}

// ==================== HuggingFace =================

async function fetchHFTrending(args: Record<string, any>): Promise<string> {
  const limit = Math.min(args.limit || 20, 50);
  const url = `https://huggingface.co/api/models?sort=trending&limit=${limit}`;
  const models = await httpGet(url);
  const items = (models || []).map((m: any, i: number) => ({
    name: m.id || m.modelId,
    likes: m.likes || 0,
    downloads: m.downloads || 0,
    tags: (m.tags || []).slice(0, 3).join(', '),
    url: `https://huggingface.co/${m.id || m.modelId}`,
  }));

  return `HuggingFace 热门模型 (${items.length}条):\n\n${formatResults(items, ['name', 'likes', 'downloads', 'tags', 'url'])}`;
}

// ==================== Wikipedia =================

async function searchWikipedia(args: Record<string, any>): Promise<string> {
  const limit = Math.min(args.limit || 10, 50);
  const url = `https://zh.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(args.query)}&limit=${limit}&format=json&origin=*`;
  const data = await httpGet(url);
  const titles: string[] = data[1] || [];
  const descriptions: string[] = data[2] || [];
  const urls: string[] = data[3] || [];

  const items = titles.map((t, i) => ({
    title: t,
    desc: descriptions[i] || '',
    url: urls[i] || `https://zh.wikipedia.org/wiki/${encodeURIComponent(t)}`,
  }));

  return `Wikipedia 搜索 "${args.query}" (${items.length}条):\n\n${items.map((item, i) =>
    `[${i + 1}] ${item.title}${item.desc ? ' — ' + item.desc : ''}\n   链接: ${item.url}`
  ).join('\n')}`;
}

async function fetchWikipediaSummary(args: Record<string, any>): Promise<string> {
  const url = `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(args.title)}`;
  try {
    const data = await httpGet(url);
    return `Wikipedia: ${data.title || args.title}\n\n${data.extract || '暂无摘要'}\n\n链接: ${data.content_urls?.desktop?.page || ''}`;
  } catch {
    // 尝试英文
    const urlEn = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(args.title)}`;
    const data = await httpGet(urlEn);
    return `Wikipedia (EN): ${data.title || args.title}\n\n${data.extract || '暂无摘要'}\n\n链接: ${data.content_urls?.desktop?.page || ''}`;
  }
}

async function fetchWikipediaTrending(args: Record<string, any>): Promise<string> {
  const limit = Math.min(args.limit || 20, 50);
  const now = new Date();
  const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const url = `https://wikistats.wmflabs.org/api.php?action=getTopPages&date=${dateStr}&project=zh.wikipedia.org&limit=${limit}&format=json`;
  try {
    const data = await httpGet(url);
    const pages = data?.pages || data || [];
    const items = Array.isArray(pages) ? pages.slice(0, limit).map((p: any, _i: number) => ({
      title: p.title || p.page_title || p.article,
      views: p.views || p.pageviews || 0,
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(p.title || p.page_title || p.article)}`,
    })) : [];

    if (items.length > 0) {
      return `Wikipedia 热门条目 (${items.length}条):\n\n${formatResults(items, ['title', 'views', 'url'])}`;
    }
  } catch {
    // fallback: Wikipedia API most-read
  }

  // Fallback: 通过 MediaWiki API 获取
  try {
    const url2 = `https://zh.wikipedia.org/w/api.php?action=query&list=random&rnlimit=${limit}&rnnamespace=0&format=json&origin=*`;
    const data2 = await httpGet(url2);
    const pages2 = data2?.query?.random || [];
    const items2 = pages2.map((p: any) => ({
      title: p.title,
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
    }));
    return `Wikipedia 随机条目 (${items2.length}条):\n\n${formatResults(items2, ['title', 'url'])}`;
  } catch (err) {
    return `获取 Wikipedia 热门条目失败: ${(err as Error).message}`;
  }
}

// ==================== 36kr =================

async function fetch36KrHot(args: Record<string, any>): Promise<string> {
  const limit = Math.min(args.limit || 20, 50);
  const url = `https://36kr.com/api/newsflash?per_page=${limit}`;
  try {
    const data = await httpGet(url, 10000);
    const items: Array<{title: string; desc: string; url: string}> = (data?.data?.items || []).slice(0, limit).map((item: any) => ({
      title: item.title || '',
      desc: item.description || '',
      url: `https://36kr.com/newsflashes/${item.id || ''}`,
    }));
    if (items.length > 0) {
      return `36氪快讯 (${items.length}条):\n\n${items.map((item, i) =>
        `[${i + 1}] ${item.title}${item.desc ? '\n   ' + item.desc.slice(0, 100) : ''}\n   链接: ${item.url}`
      ).join('\n\n')}`;
    }
  } catch {
    // fallback
  }

  // Fallback: 通过 RSS feed
  try {
    const rssUrl = 'https://36kr.com/feed';
    const resp = await fetch(rssUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });
    const text = await resp.text();
    const items: { title: string; url: string }[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(text)) !== null && items.length < limit) {
      const entry = match[1];
      const titleMatch = entry.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/);
      const linkMatch = entry.match(/<link>(.*?)<\/link>/);
      if (titleMatch && linkMatch) {
        items.push({ title: titleMatch[1], url: linkMatch[1] });
      }
    }
    return `36氪快讯 (${items.length}条):\n\n${items.map((item, i) =>
      `[${i + 1}] ${item.title}\n   链接: ${item.url}`
    ).join('\n\n')}`;
  } catch (err) {
    return `获取 36氪快讯失败: ${(err as Error).message}`;
  }
}

// ==================== 微博热搜 ====================

async function fetchWeiboHotSearch(args: Record<string, any>): Promise<string> {
  const limit = Math.min(args.limit || 20, 50);
  const containerid = '106003type%3D25%26t%3D3%26disable_hot%3D1%26filter_type%3Drealtimehot';

  try {
    const data = await httpGet(`https://m.weibo.cn/api/container/getIndex?containerid=${containerid}`, 10000);
    const cards = data?.data?.cards || [];
    const items: Array<{rank: number; title: string; hot: string; label: string; url: string}> = [];

    for (const card of cards) {
      if (card.card_group) {
        for (const item of card.card_group) {
          if (item.desc) {
            items.push({
              rank: items.length + 1,
              title: item.desc,
              hot: item.desc_extr || '',
              label: item.label_name || '',
              url: item.scheme || '',
            });
          }
        }
      }
    }

    if (items.length > 0) {
      const formatted = items.slice(0, limit).map(item =>
        `[${item.rank}] ${item.title}${item.label ? ' [' + item.label + ']' : ''}${item.hot ? ' (热度:' + item.hot + ')' : ''}${item.url ? '\n   链接: ' + item.url : ''}`
      ).join('\n');
      return `微博热搜榜 (${items.length}条):\n\n${formatted}`;
    }
  } catch {
    // fallback: weibo.com/ajax/side/hotSearch
  }

  try {
    const resp = await fetch('https://weibo.com/ajax/side/hotSearch', {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error('备用接口也失败');
    const data = await resp.json() as { data: { realtime: Array<{word: string; num: number; label_name: string}> } };
    const realtime = data?.data?.realtime || [];
    const items = realtime.slice(0, limit).map((item, i) => ({
      rank: i + 1,
      title: item.word,
      hot: item.num ? String(item.num) : '',
      label: item.label_name || '',
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word)}`,
    }));

    return `微博热搜榜 (${items.length}条):\n\n${items.map(item =>
      `[${item.rank}] ${item.title}${item.label ? ' [' + item.label + ']' : ''}${item.hot ? ' (热度:' + item.hot + ')' : ''}\n   链接: ${item.url}`
    ).join('\n')}`;
  } catch (err) {
    return `获取微博热搜失败: ${(err as Error).message}`;
  }
}

// ==================== 微博搜索 ====================

async function searchWeibo(args: Record<string, any>): Promise<string> {
  const q = encodeURIComponent(args.query || '');
  const limit = Math.min(args.limit || 10, 30);
  const data = await httpGet(`https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D1%26q%3D${q}&page_type=searchall&page=1`);
  const cards = data?.data?.cards || [];
  const items: Array<{text: string; user: string; created_at: string; reposts: number; comments: number; likes: number}> = [];

  for (const card of cards) {
    if (card.card_group) {
      for (const item of card.card_group) {
        if (item.mblog) {
          const mb = item.mblog;
          items.push({
            text: (mb.text || '').replace(/<[^>]+>/g, '').slice(0, 200),
            user: mb.user?.screen_name || '',
            created_at: mb.created_at || '',
            reposts: mb.reposts_count || 0,
            comments: mb.comments_count || 0,
            likes: mb.attitudes_count || 0,
          });
        }
      }
    }
  }

  if (items.length === 0) {
    return `微博搜索 "${args.query}": 暂无结果`;
  }

  return `微博搜索 "${args.query}" (${items.length}条):\n\n${items.slice(0, limit).map((item, i) =>
    `[${i + 1}] @${item.user} (${item.created_at})\n   ${item.text}\n   转发:${item.reposts} 评论:${item.comments} 点赞:${item.likes}`
  ).join('\n\n')}`;
}

// ==================== 导出为 ToolDefinition[] ====================

/**
 * 将 OpenCliToolDef 转换为 WorkerClaw ToolDefinition
 */
function toToolDefinition(def: OpenCliToolDef, level: PermissionLevel = 'limited'): ToolDefinition {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, arg] of Object.entries(def.args)) {
    properties[key] = {
      type: arg.type === 'number' ? 'number' : 'string',
      description: arg.description,
    };
    if (arg.required) {
      required.push(key);
    }
  }

  const executor: ToolExecutorFn = async (params, context) => {
    const toolCallId = (context as any)?.toolCallId || 'opencli';
    try {
      const result = await def.execute(params || {});
      return { toolCallId, success: true, content: result };
    } catch (err) {
      logger.error(`OpenCLI 工具执行失败: ${def.name}`, { error: (err as Error).message });
      return {
        toolCallId,
        success: false,
        content: `获取数据失败: ${(err as Error).message}`,
        error: (err as Error).message,
      };
    }
  };

  return {
    name: def.name,
    description: def.description,
    requiredLevel: level,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    executor,
  };
}

/**
 * 获取所有 OpenCLI 工具定义
 */
export function getOpenCliToolDefinitions(): ToolDefinition[] {
  return OPENCLI_TOOLS.map(def => toToolDefinition(def));
}

/**
 * 获取所有 OpenCLI 工具的元信息（名称、描述、site）
 * 用于调试和日志
 */
export function getOpenCliToolMeta(): Array<{ name: string; description: string; site: string; command: string }> {
  return OPENCLI_TOOLS.map(def => ({
    name: def.name,
    description: def.description,
    site: def.site,
    command: def.command,
  }));
}

/**
 * 获取 web_cli 通用代理工具定义
 *
 * 通过平台代理 API 调用 OpenCLI 命令（阶段三：平台中心化架构）。
 * 优先使用 POST /api/cli/execute（支持 taskId、幂等性、写操作），
 * 自动回退到 GET /api/cli/:site/:cmd（只读兼容）。
 *
 * 优点：
 * - 统一走平台代理，避免 Docker 容器内网络策略问题
 * - 平台提供缓存、限流、审计
 * - 新增 CLI 命令无需发布 WorkerClaw 新版本
 * - 支持 browser/auth 策略（塘主登录态注入）
 */
export function getWebCliToolDefinition(platformUrl?: string): ToolDefinition {
  const baseUrl = platformUrl || 'https://www.miniabc.top';

  const executor: ToolExecutorFn = async (params, context) => {
    const toolCallId = (context as any)?.toolCallId || 'web_cli';

    const { site, command, query, limit, sort, taskId, dryRun, ...extra } = params || {};

    if (!site || !command) {
      return { toolCallId, success: false, content: '缺少参数: site 和 command 是必填项。先调用 web_cli_describe 查看可用命令。', error: 'missing_params' };
    }

    // 构建 args 对象
    const args: Record<string, any> = {};
    if (query) args.q = query;
    if (limit) args.limit = limit;
    if (sort) args.sort = sort;
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) args[key] = value;
    }

    try {
      // 优先尝试 POST /api/cli/execute
      const executeUrl = `${baseUrl}/api/cli/execute`;
      const body: Record<string, any> = { site, command, args };
      if (taskId) body.taskId = taskId;
      if (dryRun) body.dryRun = true;

      const headers: Record<string, string> = {
        'User-Agent': 'WorkerClaw/1.0',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      };

      // 如果有 botId 认证信息，注入 header
      const botId = (context as any)?.botId;
      if (botId) headers['X-Bot-Id'] = botId;

      // 如果有 ownerId（私有虾塘主），也传递，让平台能获取凭据
      const ownerId = (context as any)?.ownerId;
      if (ownerId) {
        body.ownerId = ownerId;
      }

      const timeoutMs = Math.min((context as any)?.remainingMs || 30000, 30000);

      const response = await fetch(executeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      // 如果 POST 失败（比如 405），自动回退到 GET 兼容模式
      if (!response.ok && response.status === 405) {
        return await fallbackGetRequest(baseUrl, site, command, args, toolCallId, timeoutMs, headers);
      }

      if (!response.ok) {
        // 尝试从 JSON body 中提取结构化错误信息（平台可能返回 200/500 + success:false）
        const errorText = await response.text().catch(() => '');
        try {
          const errorResult = JSON.parse(errorText) as { success: boolean; error?: string; data?: any };
          if (errorResult.error) {
            return { toolCallId, success: false, content: errorResult.error, error: errorResult.error };
          }
        } catch { /* 非 JSON 格式，继续用原始错误文本 */ }
        return { toolCallId, success: false, content: `API 请求失败: HTTP ${response.status} ${errorText}`, error: `http_${response.status}` };
      }

      const result = await response.json() as { success: boolean; data: any; error?: string; duration_ms?: number; strategy?: string; _fromCache?: boolean; dryRun?: boolean; command?: { site: string; command: string; strategy: string }; message?: string };

      if (dryRun && result.dryRun) {
        return { toolCallId, success: true, content: `试运行: ${result.command?.site}/${result.command?.command} (strategy=${result.command?.strategy})\n${result.message || ''}` };
      }

      if (!result.success) {
        return { toolCallId, success: false, content: result.error || 'API 执行失败', error: result.error };
      }

      // 格式化输出
      return { toolCallId, success: true, content: formatCliResult(site, command, result.data, result.duration_ms, result.strategy, result._fromCache) };

    } catch (err) {
      logger.error(`web_cli 执行失败: ${site}/${command}`, { error: (err as Error).message });
      return { toolCallId, success: false, content: `web_cli 执行失败: ${(err as Error).message}`, error: (err as Error).message };
    }
  };

  return {
    name: 'web_cli',
    description: `通过平台代理调用 OpenCLI 命令获取互联网数据。支持 fetch（公开API）、browser（网页渲染）、auth（带登录态）三种策略。
可用命令格式: site/command，如 hackernews/top, stackoverflow/hot, v2ex/hot, reddit/hot, wikipedia/search, weibo/hot_search, weibo/search, weibo/post, weibo/retweet, weibo/comment, weibo/like, weibo/profile, zhihu/hot, zhihu/search, zhihu/article, zhihu/answer, zhihu/comment, zhihu/question, zhihu/profile, xiaohongshu/hot, xiaohongshu/search, xiaohongshu/note, xiaohongshu/comments, xiaohongshu/profile, xiaohongshu/publish, browser/fetch 等。
使用 web_cli_describe 工具查看完整命令列表。

**重要：登录态管理**
- auth 策略命令（如 weibo/post、weibo/profile、weibo/retweet、weibo/comment、weibo/like、zhihu/profile 等）的登录态由平台内部自动管理，无需向用户询问或确认登录状态。
- 平台通过塘主预先同步的 Cookie 自动注入登录态，Agent 只需提供业务参数（如微博内容、搜索关键词等）。
- 如果 auth 命令执行失败并提示"未配置登录态"或"登录态已过期"，才需要告知用户通过 Chrome 扩展同步凭据。

**微博 PR 能力**：
- weibo/hot_search: 获取微博热搜榜（fetch, 公开），可用于结合热搜话题生成自然推广文案
- weibo/search: 搜索微博内容（fetch, 公开）
- weibo/post: 发布微博（auth, 写操作）
- weibo/retweet: 转发微博（auth, 写操作），参数: id(必填), comment(转发评语), is_comment(是否作为评论转发)
- weibo/comment: 评论微博（auth, 写操作），参数: id(必填), content(必填)

**知乎 PR 能力**：
- zhihu/hot: 获取知乎热榜（fetch, 公开），可用于结合热门话题创作内容
- zhihu/search: 搜索知乎内容（fetch, 公开）
- zhihu/article: 发布知乎专栏文章（auth, 写操作），参数: title(必填), content(必填), column_id(专栏ID), draft(是否草稿)
- zhihu/answer: 回答知乎问题（auth, 写操作），参数: id(问题ID,必填), content(回答内容,必填), draft(是否草稿)
- zhihu/comment: 评论知乎内容（auth, 写操作），参数: content(必填), resource_type(answer/article/question), resource_id(必填), reply_to_id(回复某条评论)

**小红书 PR 能力**：
- xiaohongshu/hot: 小红书首页推荐 Feed（auth, 需要 Playwright）
- xiaohongshu/search: 搜索小红书笔记（auth, 需要 Playwright），参数: query(必填), limit
- xiaohongshu/note: 获取笔记正文和互动数据（auth, 需要 Playwright），参数: id(笔记ID或URL,必填)
- xiaohongshu/comments: 获取笔记评论（auth, 需要 Playwright），参数: id(笔记ID或URL,必填), limit
- xiaohongshu/profile: 获取小红书创作者信息（auth, 需要 Playwright）
- xiaohongshu/publish: 发布图文笔记（auth, 写操作, 需要 Playwright），参数: title(必填,最多20字), content(必填), images(图片URL,逗号分隔,最多9张), topics(话题标签,逗号分隔), draft(是否草稿)
- weibo/like: 点赞微博（auth, 写操作），参数: id(必填), undo(是否取消点赞)

参数: site (必填), command (必填), query (搜索关键词), limit (返回条数), taskId (关联任务ID), dryRun (试运行)`,
    requiredLevel: 'limited',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '网站/引擎名称 (如 hackernews, stackoverflow, v2ex, reddit, wikipedia, arxiv, weibo, browser 等)' },
        command: { type: 'string', description: '命令名称 (如 top, hot, new, search, post, fetch 等)' },
        query: { type: 'string', description: '搜索关键词（search 类命令必填）' },
        limit: { type: 'number', description: '返回条数（默认 20）' },
        sort: { type: 'string', description: '排序方式（如 relevance, date）' },
        taskId: { type: 'string', description: '关联任务 ID（用于审计追踪）' },
        dryRun: { type: 'boolean', description: '试运行模式（不实际执行，只校验参数）' },
      },
      required: ['site', 'command'],
    },
    executor,
  };
}

/**
 * GET 兼容回退
 */
async function fallbackGetRequest(baseUrl: string, site: string, command: string, args: Record<string, any>, toolCallId: string, timeoutMs: number, headers: Record<string, string>): Promise<ToolResult> {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null) searchParams.set(key, String(value));
  }

  const apiUrl = `${baseUrl}/api/cli/${encodeURIComponent(site)}/${encodeURIComponent(command)}?${searchParams.toString()}`;
  const response = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // 尝试从 JSON body 中提取结构化错误信息
    const errorText = await response.text().catch(() => '');
    try {
      const errorResult = JSON.parse(errorText) as { success: boolean; error?: string; data?: any };
      if (errorResult.error) {
        return { toolCallId, success: false, content: errorResult.error, error: errorResult.error };
      }
    } catch { /* 非 JSON 格式，继续用原始错误文本 */ }
    return { toolCallId, success: false, content: `API 请求失败: HTTP ${response.status} ${errorText}`, error: `http_${response.status}` };
  }

  const result = await response.json() as { success: boolean; data: any; error?: string; duration_ms?: number };

  if (!result.success) {
    return { toolCallId, success: false, content: result.error || 'API 返回空数据', error: result.error };
  }

  return { toolCallId, success: true, content: formatCliResult(site, command, result.data, result.duration_ms) };
}

/**
 * 格式化 CLI 命令返回结果
 */
function formatCliResult(site: string, command: string, data: any, duration_ms?: number, strategy?: string, fromCache?: boolean): string {
  const cacheTag = fromCache ? ' [缓存]' : '';
  const strategyTag = strategy ? ` [${strategy}]` : '';

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return `${site}/${command}: 暂无数据${strategyTag}${cacheTag}`;
    }
    const items = data.map((item: any, i: number) => {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(item)) {
        if (v === undefined || v === null || v === '') continue;
        const key = k as string;
        if (key === 'url') continue;
        parts.push(`${key}: ${v}`);
      }
      const url = item.url ? `\n   链接: ${item.url}` : '';
      return `[${i + 1}] ${parts.join(' | ')}${url}`;
    });
    return `${site}/${command} (${data.length}条, ${duration_ms || 0}ms${strategyTag}${cacheTag}):\n\n${items.join('\n')}`;
  } else if (typeof data === 'object' && data !== null) {
    const lines = Object.entries(data as Record<string, any>)
      .filter(([k, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 500) : JSON.stringify(v)}`);
    return `${site}/${command}${strategyTag}${cacheTag}:\n\n${lines.join('\n')}`;
  } else {
    return `${site}/${command}: ${data}`;
  }
}

/**
 * 获取 web_cli_describe 工具定义
 *
 * 让 Agent 动态发现平台当前支持的所有 CLI 命令，
 * 包含策略类型、是否只读、参数 schema 等元信息。
 * 无需发布新版本即可感知平台新增命令。
 */
export function getWebCliDescribeToolDefinition(platformUrl?: string): ToolDefinition {
  const baseUrl = platformUrl || 'https://www.miniabc.top';

  const executor: ToolExecutorFn = async (params, context) => {
    const toolCallId = (context as any)?.toolCallId || 'web_cli_describe';

    try {
      const response = await fetch(`${baseUrl}/api/cli/commands`, {
        headers: {
          'User-Agent': 'WorkerClaw/1.0',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return { toolCallId, success: false, content: `命令发现失败: HTTP ${response.status}`, error: `http_${response.status}` };
      }

      const result = await response.json() as { success: boolean; commands: any[]; stats: { total: number; fetch: number; browser: number; auth: number } };

      if (!result.success || !result.commands) {
        return { toolCallId, success: false, content: '命令列表为空', error: 'empty_commands' };
      }

      // 过滤
      const filterStrategy = params.strategy as string | undefined;
      const filterSite = params.site as string | undefined;

      let commands = result.commands;
      if (filterStrategy) {
        commands = commands.filter((c: any) => c.strategy === filterStrategy);
      }
      if (filterSite) {
        commands = commands.filter((c: any) => c.site === filterSite);
      }

      // 格式化
      const lines = commands.map((c: any) => {
        const readOnly = c.isReadOnly ? '只读' : '写操作';
        return `  ${c.site}/${c.command}  [${c.strategy}]  ${readOnly}  — ${c.description}`;
      });

      const statsInfo = `总计: ${result.stats.total} 个命令 (fetch=${result.stats.fetch}, browser=${result.stats.browser}, auth=${result.stats.auth})`;

      const content = [
        `CLI 命令列表${filterStrategy ? ` [${filterStrategy}]` : ''}${filterSite ? ` [${filterSite}]` : ''}:`,
        statsInfo,
        '',
        ...lines,
        '',
        '使用 web_cli 工具调用: { site, command, query, limit }',
      ].join('\n');

      return { toolCallId, success: true, content };

    } catch (err) {
      logger.error('web_cli_describe 执行失败', { error: (err as Error).message });
      return { toolCallId, success: false, content: `命令发现失败: ${(err as Error).message}`, error: (err as Error).message };
    }
  };

  return {
    name: 'web_cli_describe',
    description: `查看平台当前可用的 CLI 命令列表。动态发现平台支持的所有命令，包括 fetch（公开API）、browser（网页渲染）、auth（带登录态）三种策略。
参数: strategy (可选过滤: fetch/browser/auth), site (可选过滤: 站点名)`,
    requiredLevel: 'read_only',
    parameters: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['fetch', 'browser', 'auth'], description: '按策略过滤' },
        site: { type: 'string', description: '按站点名过滤' },
      },
    },
    executor,
  };
}
