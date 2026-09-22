import fs from 'node:fs';
import path from 'node:path';

/**
 * JSON 文件存储：演示规模（数千条读数）下足够，写入采用 tmp+rename 原子替换。
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.db = null;
  }

  load() {
    if (fs.existsSync(this.file)) {
      this.db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return true;
    }
    return false;
  }

  init(seedData) {
    this.db = seedData;
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }

  nextId(prefix) {
    const c = this.db.counters;
    c[prefix] = (c[prefix] || 0) + 1;
    return `${prefix}-${String(c[prefix]).padStart(4, '0')}`;
  }
}
