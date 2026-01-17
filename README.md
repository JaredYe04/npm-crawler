# npm-crawler

🤖 自动化的 npm 包下载量统计机器人 - 每天自动收集你的 npm 包下载数据并生成 GitHub Issue 报告

## ✨ 功能特性

- 📦 **自动发现**：自动获取指定 npm 用户下的所有包
- 📊 **多维度统计**：收集今日、本周、本月的下载量数据
- 📝 **自动报告**：每天自动创建 GitHub Issue 报告
- ⏰ **定时执行**：每天 UTC+8 的 9:00 自动运行（可手动触发）
- 🏷️ **智能标签**：自动为 Issue 添加 `npm-stats` 和 `automated` 标签
- 🔄 **去重机制**：同一天不会重复创建 Issue，而是更新已有 Issue

## 🚀 快速开始

### 1. Fork 或克隆此仓库

```bash
git clone https://github.com/your-username/npm-crawler.git
cd npm-crawler
```

### 2. 修改配置（如需要）

如果你要监控其他 npm 用户，编辑 `index.js` 文件，修改 `NPM_USERNAME` 常量：

```javascript
const NPM_USERNAME = 'your-npm-username';
```

### 3. 启用 GitHub Actions

1. 将代码推送到 GitHub
2. 进入仓库的 **Settings** → **Actions** → **General**
3. 确保 **Workflow permissions** 设置为：
   - ✅ Read and write permissions
   - ✅ Allow GitHub Actions to create and approve pull requests

### 4. 手动触发测试

1. 进入仓库的 **Actions** 标签页
2. 选择 **Daily npm Stats Report** workflow
3. 点击 **Run workflow** 按钮手动触发

## 📋 工作原理

### 数据获取流程

1. **获取包列表**：通过 npm registry API 获取用户的所有包
   ```
   GET https://registry.npmjs.org/-/user/{username}/package
   ```

2. **获取下载量**：批量查询所有包的下载统计数据
   ```
   GET https://api.npmjs.org/downloads/point/last-day/{package1},{package2},...
   GET https://api.npmjs.org/downloads/point/last-week/{package1},{package2},...
   GET https://api.npmjs.org/downloads/point/last-month/{package1},{package2},...
   ```

3. **生成报告**：将数据格式化为 Markdown 表格

4. **创建 Issue**：使用 GitHub API 创建或更新 Issue

### 报告示例

生成的 Issue 报告格式如下：

```markdown
## 📦 npm 下载量日报（2026-01-17）

> 自动生成于 2026/1/17 17:00:00

### 📊 汇总统计

- **今日总下载量**: 56
- **本周总下载量**: 350
- **本月总下载量**: 1,401

### 📈 详细数据

| Package | 今日 | 本周 | 本月 |
|---------|------|------|------|
| `package-a` | 32 | 210 | 812 |
| `package-b` | 18 | 97 | 401 |
| `package-c` | 6 | 43 | 188 |
```

## ⚙️ 配置说明

### 定时任务

默认配置为每天 UTC+8 的 9:00（UTC 17:00）执行。如需修改，编辑 `.github/workflows/daily-stats.yml`：

```yaml
schedule:
  - cron: '0 17 * * *'  # UTC 时间，17:00 = UTC+8 的 9:00
```

Cron 表达式说明：
- `0 17 * * *` = 每天 17:00 UTC
- `0 9 * * *` = 每天 9:00 UTC
- `0 */6 * * *` = 每 6 小时执行一次

### 权限要求

此项目只需要最基本的 GitHub Actions 权限：
- ✅ `issues: write` - 创建和更新 Issue
- ✅ `contents: read` - 读取仓库内容（用于 checkout）

**不需要**：
- ❌ npm token
- ❌ 账号密码
- ❌ 私有数据访问

## 🛠️ 本地开发

### 安装依赖

```bash
npm install
```

### 本地运行

```bash
# 需要设置 GITHUB_TOKEN 环境变量
export GITHUB_TOKEN=your_github_token
npm start
```

### 环境变量

- `GITHUB_TOKEN`: GitHub Personal Access Token（需要 `repo` 权限）

## 📦 项目结构

```
npm-crawler/
├── .github/
│   └── workflows/
│       └── daily-stats.yml    # GitHub Actions 工作流
├── index.js                    # 主脚本
├── package.json                # 项目配置
└── README.md                   # 说明文档
```

## 🔧 故障排查

### Issue 没有创建

1. 检查 GitHub Actions 是否正常运行
2. 查看 Actions 日志中的错误信息
3. 确认仓库的 Workflow permissions 设置正确

### 下载量为 0

- npm API 可能有延迟，新发布的包可能需要等待一段时间
- 检查包名是否正确

### API 请求失败

- npm API 有 rate limit，如果包太多可能会失败
- 脚本已实现降级方案，会自动切换到单个包逐个请求

## 📝 License

MIT

## 🙏 致谢

- [npm Registry API](https://github.com/npm/registry/blob/master/docs/REGISTRY_API.md)
- [npm Downloads API](https://github.com/npm/registry/blob/master/docs/download-counts.md)
- [GitHub Actions](https://docs.github.com/en/actions)

---

**Made with ❤️ by [jared-ye](https://www.npmjs.com/~jared-ye)**
