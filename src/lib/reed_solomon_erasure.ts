/**
 * Info: (20261105 - Luphia)
 * Reed-Solomon 糾刪碼 (Erasure Code)，運算於有限體 GF(2^8)
 * - 以 Vandermonde 矩陣推導系統化 (systematic) 編碼矩陣 E = V × inv(V[0..k-1])
 * - E 的前 k 列為單位矩陣，資料切片原樣保留；後 m 列為同位 (parity) 係數
 * - E 的任意 k 列皆可逆，因此任意 k 個切片即可還原全部切片
 * - 只使用 Uint8Array，瀏覽器與 Node.js 皆可共用
 */

const GF_SIZE = 256;
const GF_ORDER = GF_SIZE - 1;
// Info: (20261105 - Luphia) 本原多項式 x^8 + x^4 + x^3 + x^2 + 1，生成元為 2
const GF_POLYNOMIAL = 0x11d;
const MAX_TOTAL_SHARDS = GF_SIZE;

type TMatrix = Uint8Array[];

function buildTables(): { exp: Uint8Array; log: Uint8Array; mul: Uint8Array } {
  const exp = new Uint8Array(GF_ORDER * 2);
  const log = new Uint8Array(GF_SIZE);
  let x = 1;
  for (let i = 0; i < GF_ORDER; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & GF_SIZE) x ^= GF_POLYNOMIAL;
  }
  for (let i = GF_ORDER; i < GF_ORDER * 2; i++) exp[i] = exp[i - GF_ORDER];

  // Info: (20261105 - Luphia) 完整乘法表 (64 KB)，mul[a << 8 | b] = a·b，編碼熱迴圈只需查表
  const mul = new Uint8Array(GF_SIZE * GF_SIZE);
  for (let a = 1; a < GF_SIZE; a++) {
    for (let b = 1; b < GF_SIZE; b++) {
      mul[(a << 8) | b] = exp[log[a] + log[b]];
    }
  }
  return { exp, log, mul };
}

const { exp: EXP_TABLE, log: LOG_TABLE, mul: MUL_TABLE } = buildTables();

function gfMul(a: number, b: number): number {
  return MUL_TABLE[(a << 8) | b];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('GF(2^8) 除以零');
  if (a === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + GF_ORDER - LOG_TABLE[b]];
}

function gfPow(a: number, n: number): number {
  if (n === 0) return 1;
  if (a === 0) return 0;
  return EXP_TABLE[(LOG_TABLE[a] * n) % GF_ORDER];
}

function createMatrix(rows: number, cols: number): TMatrix {
  return Array.from({ length: rows }, () => new Uint8Array(cols));
}

function vandermonde(rows: number, cols: number): TMatrix {
  const matrix = createMatrix(rows, cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) matrix[r][c] = gfPow(r, c);
  }
  return matrix;
}

function multiplyMatrix(a: TMatrix, b: TMatrix): TMatrix {
  const cols = b[0].length;
  const inner = b.length;
  const result = createMatrix(a.length, cols);
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < cols; c++) {
      let value = 0;
      for (let i = 0; i < inner; i++) value ^= gfMul(a[r][i], b[i][c]);
      result[r][c] = value;
    }
  }
  return result;
}

/**
 * Info: (20261105 - Luphia)
 * 以 Gauss-Jordan 消去法求反矩陣 (GF(2^8) 中加減法皆為 XOR)
 */
function invertMatrix(source: TMatrix): TMatrix {
  const size = source.length;
  const work = source.map((row, r) => {
    const extended = new Uint8Array(size * 2);
    extended.set(row);
    extended[size + r] = 1;
    return extended;
  });

  for (let col = 0; col < size; col++) {
    let pivot = col;
    while (pivot < size && work[pivot][col] === 0) pivot++;
    if (pivot === size) throw new Error('矩陣不可逆');
    if (pivot !== col) [work[pivot], work[col]] = [work[col], work[pivot]];

    const pivotRow = work[col];
    const scale = pivotRow[col];
    if (scale !== 1) {
      for (let c = 0; c < size * 2; c++) pivotRow[c] = gfDiv(pivotRow[c], scale);
    }

    for (let r = 0; r < size; r++) {
      const factor = work[r][col];
      if (r === col || factor === 0) continue;
      const row = work[r];
      for (let c = 0; c < size * 2; c++) row[c] ^= gfMul(factor, pivotRow[c]);
    }
  }

  return work.map(row => row.slice(size));
}

/**
 * Info: (20261105 - Luphia)
 * outputs[o] = Σ coefficients[o][i] · inputs[i]，以位元組為單位查表計算
 */
function codeShards(coefficients: TMatrix, inputs: Uint8Array[], outputs: Uint8Array[], byteCount: number): void {
  for (let o = 0; o < outputs.length; o++) {
    const output = outputs[o];
    const row = coefficients[o];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const base = row[i] << 8;
      const table = MUL_TABLE.subarray(base, base + GF_SIZE);
      if (i === 0) {
        for (let j = 0; j < byteCount; j++) output[j] = table[input[j]];
      } else {
        for (let j = 0; j < byteCount; j++) output[j] ^= table[input[j]];
      }
    }
  }
}

export class ReedSolomonErasure {
  readonly dataShards: number;
  readonly parityShards: number;
  readonly totalShards: number;
  private readonly encodeMatrix: TMatrix;
  private readonly parityMatrix: TMatrix;

  constructor(dataShards: number, parityShards: number) {
    if (!Number.isInteger(dataShards) || dataShards < 1) {
      throw new Error('dataShards 必須是正整數');
    }
    if (!Number.isInteger(parityShards) || parityShards < 1) {
      throw new Error('parityShards 必須是正整數');
    }
    if (dataShards + parityShards > MAX_TOTAL_SHARDS) {
      throw new Error(`切片總數不可超過 ${MAX_TOTAL_SHARDS}`);
    }

    this.dataShards = dataShards;
    this.parityShards = parityShards;
    this.totalShards = dataShards + parityShards;

    const v = vandermonde(this.totalShards, dataShards);
    const topInverse = invertMatrix(v.slice(0, dataShards));
    this.encodeMatrix = multiplyMatrix(v, topInverse);
    this.parityMatrix = this.encodeMatrix.slice(dataShards);
  }

  /**
   * Info: (20261105 - Luphia)
   * 依前 k 個資料切片計算後 m 個同位切片並就地寫入 shards[k..n-1]
   * 所有切片必須已配置且長度相同
   */
  encode(shards: Uint8Array[]): void {
    const byteCount = this.checkShardSizes(shards, true);
    codeShards(
      this.parityMatrix,
      shards.slice(0, this.dataShards),
      shards.slice(this.dataShards),
      byteCount
    );
  }

  /**
   * Info: (20261105 - Luphia)
   * 檢查同位切片是否與資料切片一致
   */
  verify(shards: Uint8Array[]): boolean {
    const byteCount = this.checkShardSizes(shards, true);
    const expected = Array.from({ length: this.parityShards }, () => new Uint8Array(byteCount));
    codeShards(this.parityMatrix, shards.slice(0, this.dataShards), expected, byteCount);
    return expected.every((parity, p) => {
      const actual = shards[this.dataShards + p];
      for (let j = 0; j < byteCount; j++) if (parity[j] !== actual[j]) return false;
      return true;
    });
  }

  /**
   * Info: (20261105 - Luphia)
   * 以 null 表示遺失的切片，就地補回遺失切片
   * - 至少需要 k 個切片
   * - dataOnly = true 時只補回資料切片 (還原檔案時不需要同位切片)
   */
  reconstruct(shards: (Uint8Array | null)[], dataOnly = false): Uint8Array[] {
    if (shards.length !== this.totalShards) {
      throw new Error(`需要 ${this.totalShards} 個切片位置，收到 ${shards.length} 個`);
    }
    const byteCount = this.checkShardSizes(shards, false);
    const present: number[] = [];
    shards.forEach((shard, i) => {
      if (shard) present.push(i);
    });
    if (present.length < this.dataShards) {
      throw new Error(`可用切片不足：需要 ${this.dataShards} 個，只有 ${present.length} 個`);
    }

    const missingData: number[] = [];
    const missingParity: number[] = [];
    shards.forEach((shard, i) => {
      if (shard) return;
      if (i < this.dataShards) missingData.push(i);
      else missingParity.push(i);
    });

    if (missingData.length > 0) {
      // Info: (20261105 - Luphia) 取前 k 個可用切片 (優先使用資料切片，計算量最少)
      const chosen = present.slice(0, this.dataShards);
      const decodeMatrix = invertMatrix(chosen.map(i => this.encodeMatrix[i]));
      const inputs = chosen.map(i => shards[i] as Uint8Array);
      const outputs = missingData.map(() => new Uint8Array(byteCount));
      codeShards(missingData.map(i => decodeMatrix[i]), inputs, outputs, byteCount);
      missingData.forEach((shardIndex, o) => {
        shards[shardIndex] = outputs[o];
      });
    }

    if (!dataOnly && missingParity.length > 0) {
      const inputs = shards.slice(0, this.dataShards) as Uint8Array[];
      const outputs = missingParity.map(() => new Uint8Array(byteCount));
      codeShards(missingParity.map(i => this.parityMatrix[i - this.dataShards]), inputs, outputs, byteCount);
      missingParity.forEach((shardIndex, o) => {
        shards[shardIndex] = outputs[o];
      });
    }

    return shards as Uint8Array[];
  }

  private checkShardSizes(shards: (Uint8Array | null)[], requireAll: boolean): number {
    if (shards.length !== this.totalShards) {
      throw new Error(`需要 ${this.totalShards} 個切片，收到 ${shards.length} 個`);
    }
    let byteCount = -1;
    for (let i = 0; i < shards.length; i++) {
      const shard = shards[i];
      if (!shard) {
        if (requireAll) throw new Error(`切片 ${i + 1} 未配置`);
        continue;
      }
      if (byteCount === -1) byteCount = shard.length;
      else if (shard.length !== byteCount) throw new Error('所有切片長度必須相同');
    }
    if (byteCount === -1) throw new Error('沒有任何可用切片');
    return byteCount;
  }
}
