import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Root as MdastRoot, RootContent } from 'mdast';

/**
 * Info: (20261118 - Luphia)
 * 文件區塊切分 (瀏覽器與伺服器共用)：以 Markdown 第一層節點為一個區塊
 */

export type TDocBlockKind = 'heading' | 'paragraph' | 'list' | 'table' | 'math' | 'mermaid' | 'code' | 'quote' | 'pagebreak' | 'rule' | 'other';

export interface IDocBlock {
  start: number;
  end: number;
  text: string;
  kind: TDocBlockKind;
  // Info: (20261118 - Luphia) 標題層級 (# = 1)
  depth?: number;
}

export const PAGEBREAK = /^<!--\s*pagebreak\s*-->$/i;

const kindOf = (node: RootContent): TDocBlockKind => {
  switch (node.type) {
    case 'heading':
      return 'heading';
    case 'paragraph':
      return 'paragraph';
    case 'list':
      return 'list';
    case 'table':
      return 'table';
    case 'math':
      return 'math';
    case 'code':
      return (node.lang || '').toLowerCase() === 'mermaid' ? 'mermaid' : 'code';
    case 'blockquote':
      return 'quote';
    case 'thematicBreak':
      return 'rule';
    case 'html':
      return PAGEBREAK.test(node.value.trim()) ? 'pagebreak' : 'other';
    default:
      return 'other';
  }
};

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/**
 * Info: (20261118 - Luphia)
 * 將文件內容 (不含 front matter) 切成第一層區塊；start / end 為在 body 中的位置
 */
export function splitBlocks(body: string): IDocBlock[] {
  const tree = parser.parse(body) as MdastRoot;
  return tree.children
    .filter(node => node.position?.start.offset !== undefined && node.position?.end.offset !== undefined)
    .map(node => {
      const start = node.position!.start.offset as number;
      const end = node.position!.end.offset as number;
      return { start, end, text: body.slice(start, end), kind: kindOf(node), ...(node.type === 'heading' ? { depth: node.depth } : {}) };
    });
}


// Info: (20261118 - Luphia) 區塊以空行相接組回文件內容
export const joinBlocks = (texts: string[]) => (texts.length ? `${texts.join('\n\n')}\n` : '');
