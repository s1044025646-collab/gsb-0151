# GBC — 灰度图块压缩与重建误差分析后端

从零实现的 Windows 本地可运行后端：TypeScript + Node.js（内置 `node:sqlite`），
自带 HTTP API、CLI、合成灰度图夹具和自动化测试。**没有网页，也没有调用任何
现成图像编码器。**

压缩管线使用自己公开的容器格式 **GBC（Gray Block Codec，魔数 `GBC1`）**，
包含自行实现的 8×8 正交 DCT/IDCT、中心化、量化、Z 字扫描和零游程编码。
**不宣称、也不兼容 JPEG。**

## 依赖

- Node.js ≥ 22.5（开发于 Node 25；`node:sqlite` 为内置实验模块，无需原生编译）
- 仅开发依赖：`typescript`、`@types/node`（`npm install` 获取）
- Windows / PowerShell；数据与临时文件全部位于本项目 `tmp/`

## 安装 / 构建

```powershell
npm install
npm run build
```

## 测试

```powershell
npm test
```

30 个测试，覆盖：无量化变换往返、正交性与 Parseval 能量关系、Z 字/游程还原、
容器独立解码（只依赖文件内头部与载荷）、已知误差指标、损坏输入（截断、坏魔数、
坏版本号、尾部垃圾）、非法量化步长/尺寸溢出/非法游程、事务回滚、幂等重放、
重启后持久化、分页与 API 失败路径。

## 可重复演示

```powershell
npm run demo
```

演示使用注入时钟生成确定 ID 与时间戳，重建独立的 `tmp/demo.sqlite`，
遍历常量/渐变/棋盘/脉冲/随机（含非 8 整倍数尺寸）夹具，输出不同量化强度下的
实际序列化字节数、MSE、PSNR（零误差显示 `Infinity dB (zero error)`）和最大误差，
并导出 `tmp/demo-errors.json`。

## 启动 / 停止 API

```powershell
npm start              # 只绑定 127.0.0.1，端口 0 = 系统自动分配，打印实际端口
npm stop               # 仅按 tmp/gbc.pid 停止本项目自己启动的进程
```

服务监听 `http://127.0.0.1:<自动端口>`，SQLite 文件为 `tmp/gbc.sqlite`。

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/images` | 导入 8 位灰度矩阵（内容校验和去重） |
| GET | `/images?limit=&offset=` | 分页查询 |
| GET | `/images/:id` | 单张图像 |
| POST | `/quant-tables` | `{steps:[64 正数]}` 或 `{preset:"uniform"|"scaled",...}` |
| GET | `/quant-tables?limit=&offset=` | 分页查询 |
| GET | `/quant-tables/:id` | 单表（含 64 步长） |
| POST | `/artifacts` | 压缩，必须带 `idempotencyKey`；首次 201，重放 200 |
| GET | `/artifacts?limit=&offset=&imageId=` | 分页查询 |
| GET | `/artifacts/:id` | 元数据 + base64 容器字节 |
| GET | `/artifacts/:id/pixels` | 仅凭容器重建（不读取原图） |
| GET | `/artifacts/:id/report` | MSE / PSNR / 最大误差 |
| GET | `/artifacts/:id/errors` | 逐像素误差矩阵（原图 − 重建） |

错误响应形如 `{"error":{"code":"INVALID_DIMENSIONS","message":"..."}}`，
错误码：`INVALID_DIMENSIONS`、`INVALID_PIXEL_VALUE`、`SIZE_OVERFLOW`、
`INVALID_QUANT_STEP`、`INVALID_PADDING`、`INVALID_FORMAT_VERSION`、`BAD_MAGIC`、
`TRUNCATED_PAYLOAD`、`INVALID_RUN`、`INVALID_COEFFICIENT`、`INVALID_HEADER`、
`NOT_FOUND`、`VALIDATION`、`CONFLICT`。

快速调用示例：

```powershell
node --no-warnings dist/src/cli/index.js compress --image <imageId> --table 1
```

## CLI

全局选项 `--db tmp/gbc.sqlite`（默认即该路径）。命令须写在参数之前。

```powershell
node dist/src/cli/index.js import                                  # 导入内置合成夹具
node dist/src/cli/index.js import --source image.json              # 或导入外部 JSON
node dist/src/cli/index.js quant-table --name coarse --preset scaled --strength 70
node dist/src/cli/index.js compress --image <id> --table 1 --padding reflect --key k1
node dist/src/cli/index.js decompress --artifact <id>
node dist/src/cli/index.js coeffs  --artifact <id> --bx 0 --by 0   # 查看指定块系数量化值
node dist/src/cli/index.js scan   --image <id> --from 10 --to 90 --step 20
node dist/src/cli/index.js errors --artifact <id>                  # 导出误差矩阵
node dist/src/cli/index.js list
```

`import`/`quant-table`/`compress` 会打印操作前后的库内计数；`compress` 打印
**实际序列化字节数** `serializedBytes`，与非零系数个数无关。

## 容器与数值规则（明确约定）

- **容器（v1）**：`GBC1` + 版本字节 + 原始宽高（u16）+ 填充策略字节 +
  保留字节 + 64 个 float32 量化步长（自然序）+ 分块载荷。每块：u16 令牌数，
  随后 `(run:u8, value:有符号 LEB128-zigzag)`；尾部全零一律省略。
- **分块填充**：8×8 网格，支持 `zero` / `edge` / `reflect`；头部保存原始
  宽高与填充策略，解码后裁掉所有填充行/列，只输出有效像素。
- **中心化**：编码前像素减 128；重建后加 128。
- **DCT 归一**：8 点正交基，`C0=√(1/8)`，`Ck=√(2/8)`，可分离
  `F = T S Tᵀ`、`S = Tᵀ F T`；满足 Parseval 能量守恒。
- **量化**：`q = sgn(c)·floor(|c|/step + 1/2)`（负数关于零对称，半数远离
  零方向）；`step` 必须为正有限数，否则拒绝；反量化 `c' = q·step`，
  计算时使用与头部 float32 一致的步长精度。
- **游程**：run ∈ [0,63]，value 必须为非零整数；run 越过块尾或令牌截断即
  `INVALID_RUN`/`TRUNCATED_PAYLOAD`；载荷多余字节同样拒绝。
- **像素裁剪**：重建值四舍五入到最近整数后夹取到 [0,255]，负零归一为 0。
- **指标**：MSE、PSNR（`10·log10(255²/MSE)`）、最大误差只统计
  宽×高个**原始有效像素**；MSE=0 时以 `psnrState:"infinite"`、`psnrDb:null`
  明确表示无穷 PSNR。
- **尺寸**：宽高为 1..65535 的正整数；越界为 `SIZE_OVERFLOW`。

## 数据与清理

- 所有数据库、WAL、容器与导出文件都在项目内 `tmp/`；构建产物在 `dist/`。
- `npm run clean` 只删除本项目的 `dist/` 与 `tmp/`。
- 迁移使用 `CREATE TABLE IF NOT EXISTS` 与 `PRAGMA user_version`，可重复执行；
  重复打开库文件已在测试中验证。
