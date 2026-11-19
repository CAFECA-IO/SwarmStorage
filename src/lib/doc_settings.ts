/**
 * Info: (20261118 - Luphia)
 * 文件 (Markdown) 的版面設定：存放在檔案開頭的 front matter (pdf-* 欄位)，跟著文件一起保存與分享
 * ---
 * pdf-theme: teal
 * pdf-headings: numbered
 * ---
 * 其他 front matter 欄位原樣保留；全部為預設值時不寫入
 */

export type TDocTheme = 'blue' | 'teal' | 'amber' | 'mono';
// Info: (20261119 - Luphia) 版面風格：色塊、色帶、編輯 (標題不編號)
export type TDocStyle = 'block' | 'ribbon' | 'editorial';
export type TPaper = 'a4' | 'letter';
export type TMargins = 'normal' | 'narrow';
export type TDocFont = 'serif' | 'sans';

export interface IDocSettings {
  theme: TDocTheme;
  style: TDocStyle;
  paper: TPaper;
  margins: TMargins;
  font: TDocFont;
  toc: boolean;
  titlePage: boolean;
  equationNumbers: boolean;
}

export const DEFAULT_DOC_SETTINGS: IDocSettings = {
  theme: 'blue',
  style: 'block',
  paper: 'a4',
  margins: 'normal',
  font: 'serif',
  toc: false,
  titlePage: false,
  equationNumbers: false,
};

// Info: (20261118 - Luphia) 主色 (色塊)、淺色 (封面底、表頭)、深色文字；文字與色塊對比皆 ≥ 4.5:1
export const DOC_THEMES: Record<TDocTheme, { label: string; accent: string; soft: string; ink: string }> = {
  blue: { label: 'Blue', accent: '#1E40AF', soft: '#DBEAFE', ink: '#172554' },
  teal: { label: 'Teal', accent: '#0F766E', soft: '#CCFBF1', ink: '#042F2E' },
  amber: { label: 'Amber', accent: '#C2410C', soft: '#FFEDD5', ink: '#431407' },
  mono: { label: 'Mono', accent: '#1F2937', soft: '#F3F4F6', ink: '#030712' },
};

export const DOC_STYLES: Record<TDocStyle, { label: string; hint: string }> = {
  block: { label: 'Color block', hint: 'Title in a tinted band, a color square before each heading' },
  ribbon: { label: 'Ribbon', hint: 'Solid title bar, headings on a tinted ribbon' },
  editorial: { label: 'Editorial', hint: 'Large title with a rule, quiet headings with an accent mark' },
};

export const PAPER_LABELS: Record<TPaper, string> = { a4: 'A4', letter: 'Letter' };
// Info: (20261119 - Luphia) 編輯器頁面寬度與紙張相同 (所見即所得)
export const PAPER_WIDTHS: Record<TPaper, string> = { a4: '210mm', letter: '8.5in' };
export const MARGIN_SIZES: Record<TMargins, string> = { normal: '22mm', narrow: '14mm' };

const KEYS: { [K in keyof IDocSettings]: string } = {
  theme: 'pdf-theme',
  style: 'pdf-style',
  paper: 'pdf-paper',
  margins: 'pdf-margins',
  font: 'pdf-font',
  toc: 'pdf-toc',
  titlePage: 'pdf-title-page',
  equationNumbers: 'pdf-equation-numbers',
};

const CHOICES: Partial<Record<keyof IDocSettings, readonly string[]>> = {
  theme: Object.keys(DOC_THEMES),
  style: ['block', 'ribbon', 'editorial'],
  paper: ['a4', 'letter'],
  margins: ['normal', 'narrow'],
  font: ['serif', 'sans'],
};

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface ISplitDoc {
  // Info: (20261118 - Luphia) front matter 內容 (不含 ---)；沒有時為 null
  front: string | null;
  body: string;
}

export function splitFrontMatter(source: string): ISplitDoc {
  const match = FRONT_MATTER.exec(source);
  if (!match) return { front: null, body: source };
  return { front: match[1], body: source.slice(match[0].length) };
}

export function joinFrontMatter(front: string | null, body: string): string {
  return front && front.trim() ? `---\n${front.trim()}\n---\n${body}` : body;
}

export function readDocSettings(source: string): IDocSettings {
  const { front } = splitFrontMatter(source);
  const settings: IDocSettings = { ...DEFAULT_DOC_SETTINGS };
  if (!front) return settings;
  const values = new Map<string, string>();
  front.split(/\r?\n/).forEach(line => {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2].replace(/^["']|["']$/g, ''));
  });
  (Object.keys(KEYS) as (keyof IDocSettings)[]).forEach(key => {
    const raw = values.get(KEYS[key]);
    if (raw === undefined) return;
    if (typeof DEFAULT_DOC_SETTINGS[key] === 'boolean') {
      (settings[key] as boolean) = /^(true|yes|on)$/i.test(raw);
    } else if (CHOICES[key]?.includes(raw)) {
      (settings[key] as string) = raw;
    }
  });
  return settings;
}

/**
 * Info: (20261118 - Luphia)
 * 寫回設定：更新或移除 pdf-* 欄位，其他 front matter 不變
 */
export function writeDocSettings(source: string, settings: IDocSettings): string {
  const { front, body } = splitFrontMatter(source);
  // Info: (20261119 - Luphia) 舊版欄位 (標題編號、頁碼) 一併移除
  const managed = new Set([...Object.values(KEYS), 'pdf-headings', 'pdf-page-numbers']);
  const kept = (front ?? '').split(/\r?\n/).filter(line => {
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    return line.trim() !== '' && !(match && managed.has(match[1]));
  });
  const lines = (Object.keys(KEYS) as (keyof IDocSettings)[])
    .filter(key => settings[key] !== DEFAULT_DOC_SETTINGS[key])
    .map(key => `${KEYS[key]}: ${String(settings[key])}`);
  return joinFrontMatter([...kept, ...lines].join('\n'), body);
}

export const isDocument = (filename: string) => /\.(md|markdown)$/i.test(filename);

// Info: (20261118 - Luphia) 新文件範本
export const NEW_DOC_TEMPLATE = (title: string) => `# ${title}

Start writing here. Type **/** on an empty line to insert an equation, a Mermaid diagram, a table or an image from this room.

## Section

$$
E = mc^2
$$
`;
