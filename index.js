import * as core from '@actions/core';
import * as github from '@actions/github';

const NPM_USERNAME = 'jared-ye';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const NPM_API = 'https://api.npmjs.org';

/**
 * 获取用户的所有 npm 包
 */
async function getUserPackages(username) {
  try {
    const response = await fetch(`${NPM_REGISTRY}/-/user/${username}/package`);
    if (!response.ok) {
      throw new Error(`Failed to fetch packages: ${response.statusText}`);
    }
    const data = await response.json();
    return Object.keys(data);
  } catch (error) {
    core.setFailed(`Error fetching packages: ${error.message}`);
    throw error;
  }
}

/**
 * 获取包的下载量统计
 */
async function getPackageDownloads(packageNames) {
  if (packageNames.length === 0) {
    return [];
  }

  // npm API 批量请求：使用逗号分隔的包名
  // 如果包太多，分批处理（每批最多 10 个）
  const BATCH_SIZE = 10;
  const batches = [];
  for (let i = 0; i < packageNames.length; i += BATCH_SIZE) {
    batches.push(packageNames.slice(i, i + BATCH_SIZE));
  }

  const allStats = [];

  for (const batch of batches) {
    const packagesStr = batch.join(',');
    
    try {
      const [lastDay, lastWeek, lastMonth] = await Promise.all([
        fetch(`${NPM_API}/downloads/point/last-day/${packagesStr}`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`${NPM_API}/downloads/point/last-week/${packagesStr}`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`${NPM_API}/downloads/point/last-month/${packagesStr}`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
      ]);

      // 处理返回的数据结构
      // npm API 批量请求返回对象 { "package-name": { downloads, package, ... }, ... }
      // 单个请求返回对象 { downloads, package, start, end }
      // 注意：某些包可能返回 null（如新包或已删除的包）
      const processResponse = (response, pkg) => {
        // 批量请求：返回的是对象，键是包名
        if (response && typeof response === 'object' && !Array.isArray(response)) {
          // 检查是否是批量请求格式（有包名作为键）
          if (response[pkg]) {
            // 处理 null 的情况
            if (response[pkg] === null) {
              return 0;
            }
            return response[pkg].downloads || 0;
          }
          // 单个请求格式：直接有 package 字段
          if (response.package === pkg) {
            return response.downloads || 0;
          }
        }
        // 数组格式（虽然 npm API 通常不返回数组，但保留兼容性）
        if (Array.isArray(response)) {
          const item = response.find(p => p.package === pkg);
          return item?.downloads || 0;
        }
        return 0;
      };

      batch.forEach(pkg => {
        allStats.push({
          name: pkg,
          lastDay: processResponse(lastDay, pkg),
          lastWeek: processResponse(lastWeek, pkg),
          lastMonth: processResponse(lastMonth, pkg)
        });
      });

      // 添加小延迟避免 rate limit
      if (batches.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (error) {
      core.warning(`Batch request failed, falling back to individual requests: ${error.message}`);
      // 如果批量请求失败，对这批包使用单个请求
      const fallbackStats = await getPackageDownloadsFallback(batch);
      allStats.push(...fallbackStats);
    }
  }

  return allStats;
}

/**
 * 降级方案：单个包逐个请求
 */
async function getPackageDownloadsFallback(packageNames) {
  const stats = [];
  for (const pkg of packageNames) {
    try {
      const [day, week, month] = await Promise.all([
        fetch(`${NPM_API}/downloads/point/last-day/${pkg}`).then(r => r.json()).catch(() => ({ downloads: 0 })),
        fetch(`${NPM_API}/downloads/point/last-week/${pkg}`).then(r => r.json()).catch(() => ({ downloads: 0 })),
        fetch(`${NPM_API}/downloads/point/last-month/${pkg}`).then(r => r.json()).catch(() => ({ downloads: 0 }))
      ]);

      stats.push({
        name: pkg,
        lastDay: day.downloads || 0,
        lastWeek: week.downloads || 0,
        lastMonth: month.downloads || 0
      });
    } catch (error) {
      core.warning(`Failed to fetch stats for ${pkg}: ${error.message}`);
      stats.push({
        name: pkg,
        lastDay: 0,
        lastWeek: 0,
        lastMonth: 0
      });
    }
  }
  return stats;
}

/**
 * 生成 Markdown 报告
 */
function generateReport(stats, date) {
  const totalWeek = stats.reduce((sum, stat) => sum + stat.lastWeek, 0);
  const totalMonth = stats.reduce((sum, stat) => sum + stat.lastMonth, 0);
  const totalDay = stats.reduce((sum, stat) => sum + stat.lastDay, 0);

  // 按周下载量排序
  const sortedStats = [...stats].sort((a, b) => b.lastWeek - a.lastWeek);

  let report = `## 📦 npm 下载量日报（${date}）\n\n`;
  report += `> 自动生成于 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n`;
  
  report += `### 📊 汇总统计\n\n`;
  report += `- **今日总下载量**: ${totalDay.toLocaleString()}\n`;
  report += `- **本周总下载量**: ${totalWeek.toLocaleString()}\n`;
  report += `- **本月总下载量**: ${totalMonth.toLocaleString()}\n\n`;

  report += `### 📈 详细数据\n\n`;
  report += `| Package | 今日 | 本周 | 本月 |\n`;
  report += `|---------|------|------|------|\n`;

  sortedStats.forEach(stat => {
    report += `| \`${stat.name}\` | ${stat.lastDay.toLocaleString()} | ${stat.lastWeek.toLocaleString()} | ${stat.lastMonth.toLocaleString()} |\n`;
  });

  report += `\n---\n\n`;
  report += `*由 [npm-crawler](https://github.com/${github.context.repo.owner}/${github.context.repo.repo}) 自动生成*`;

  return report;
}

/**
 * 创建或查找 Issue
 */
async function createOrUpdateIssue(octokit, report, date) {
  const { owner, repo } = github.context.repo;
  const issueTitle = `📦 npm stats - ${date}`;

  try {
    // 先查找今天是否已经有 Issue
    const { data: issues } = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      labels: 'npm-stats',
      per_page: 10
    });

    const todayIssue = issues.find(issue => issue.title === issueTitle);

    if (todayIssue) {
      // 如果已存在，更新 Issue 内容
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: todayIssue.number,
        body: report
      });
      core.info(`Updated existing issue #${todayIssue.number}`);
      return todayIssue.number;
    } else {
      // 创建新 Issue
      const { data: issue } = await octokit.rest.issues.create({
        owner,
        repo,
        title: issueTitle,
        body: report,
        labels: ['npm-stats', 'automated']
      });
      core.info(`Created new issue #${issue.number}`);
      return issue.number;
    }
  } catch (error) {
    core.setFailed(`Error creating/updating issue: ${error.message}`);
    throw error;
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    core.info(`🚀 Starting npm stats collection for user: ${NPM_USERNAME}`);

    // 获取所有包
    core.info('📦 Fetching packages...');
    const packages = await getUserPackages(NPM_USERNAME);
    core.info(`Found ${packages.length} packages: ${packages.join(', ')}`);

    if (packages.length === 0) {
      core.warning('No packages found for this user');
      return;
    }

    // 获取下载量统计
    core.info('📊 Fetching download statistics...');
    const stats = await getPackageDownloads(packages);
    core.info(`Successfully fetched stats for ${stats.length} packages`);

    // 生成报告
    const today = new Date().toISOString().split('T')[0];
    const report = generateReport(stats, today);
    core.info('📝 Report generated');

    // 创建 Issue
    const token = core.getInput('github_token') || process.env.GITHUB_TOKEN;
    if (!token) {
      core.setFailed('GITHUB_TOKEN is required');
      return;
    }

    const octokit = github.getOctokit(token);
    const issueNumber = await createOrUpdateIssue(octokit, report, today);
    
    core.info(`✅ Successfully created/updated issue #${issueNumber}`);
    core.setOutput('issue_number', issueNumber);
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
    process.exit(1);
  }
}

// 运行主函数
main();

