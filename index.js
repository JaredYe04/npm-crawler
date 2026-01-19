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
 * 从 Issue body 中解析上一次的统计数据
 */
function parsePreviousStats(issueBody) {
  const stats = {};
  
  // 首先提取汇总统计数据（无论是否有表格都要提取）
  const totalDayMatch = issueBody.match(/- \*\*今日总下载量\*\*: ([\d,]+)/);
  const totalWeekMatch = issueBody.match(/- \*\*本周总下载量\*\*: ([\d,]+)/);
  const totalMonthMatch = issueBody.match(/- \*\*本月总下载量\*\*: ([\d,]+)/);
  
  if (totalDayMatch || totalWeekMatch || totalMonthMatch) {
    stats['_total'] = {
      lastDay: totalDayMatch ? parseInt(totalDayMatch[1].replace(/,/g, '')) : 0,
      lastWeek: totalWeekMatch ? parseInt(totalWeekMatch[1].replace(/,/g, '')) : 0,
      lastMonth: totalMonthMatch ? parseInt(totalMonthMatch[1].replace(/,/g, '')) : 0
    };
  }
  
  // 尝试从表格中提取各个包的详细数据
  const tableMatch = issueBody.match(/\| Package \| 今日 \| 本周 \| 本月 \|/);
  if (tableMatch) {
    const tableStart = issueBody.indexOf(tableMatch[0]);
    const tableEnd = issueBody.indexOf('\n\n', tableStart);
    const tableContent = issueBody.substring(tableStart, tableEnd !== -1 ? tableEnd : issueBody.length);
    
    // 匹配表格行：| `package-name` | 数字（可能包含增长信息）| 数字 | 数字 |
    // 增长信息格式：数字 ↑/↓ +数字 (+百分比%)，我们只需要提取第一个数字
    const rowRegex = /\| `([^`]+)` \| ([\d,]+)(?:\s+[↑↓→].*?)? \| ([\d,]+)(?:\s+[↑↓→].*?)? \| ([\d,]+)(?:\s+[↑↓→].*?)? \|/g;
    let match;
    while ((match = rowRegex.exec(tableContent)) !== null) {
      const pkg = match[1];
      stats[pkg] = {
        lastDay: parseInt(match[2].replace(/,/g, '')) || 0,
        lastWeek: parseInt(match[3].replace(/,/g, '')) || 0,
        lastMonth: parseInt(match[4].replace(/,/g, '')) || 0
      };
    }
  }
  
  return stats;
}

/**
 * 计算增长量和增长率
 */
function calculateGrowth(current, previous) {
  if (!previous || previous === 0) {
    return { change: current, changePercent: current > 0 ? 100 : 0 };
  }
  const change = current - previous;
  const changePercent = ((change / previous) * 100).toFixed(1);
  return { change, changePercent };
}

/**
 * 格式化增长显示
 */
function formatGrowth(growth) {
  const { change, changePercent } = growth;
  if (change === 0) {
    return '→ 0 (0.0%)';
  }
  const arrow = change > 0 ? '↑' : '↓';
  const sign = change > 0 ? '+' : '';
  return `${arrow} ${sign}${change.toLocaleString()} (${sign}${changePercent}%)`;
}

/**
 * 生成 Markdown 报告
 */
function generateReport(stats, date, previousStats = null) {
  const totalWeek = stats.reduce((sum, stat) => sum + stat.lastWeek, 0);
  const totalMonth = stats.reduce((sum, stat) => sum + stat.lastMonth, 0);
  const totalDay = stats.reduce((sum, stat) => sum + stat.lastDay, 0);

  // 计算汇总的增长
  const prevTotal = previousStats?.['_total'] || {};
  const dayGrowth = calculateGrowth(totalDay, prevTotal.lastDay);
  const weekGrowth = calculateGrowth(totalWeek, prevTotal.lastWeek);
  const monthGrowth = calculateGrowth(totalMonth, prevTotal.lastMonth);

  // 按周下载量排序
  const sortedStats = [...stats].sort((a, b) => b.lastWeek - a.lastWeek);

  let report = `## 📦 npm 下载量日报（${date}）\n\n`;
  report += `> 自动生成于 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n`;
  
  report += `### 📊 汇总统计\n\n`;
  report += `- **今日总下载量**: ${totalDay.toLocaleString()} ${previousStats ? `(${formatGrowth(dayGrowth)})` : ''}\n`;
  report += `- **本周总下载量**: ${totalWeek.toLocaleString()} ${previousStats ? `(${formatGrowth(weekGrowth)})` : ''}\n`;
  report += `- **本月总下载量**: ${totalMonth.toLocaleString()} ${previousStats ? `(${formatGrowth(monthGrowth)})` : ''}\n\n`;

  report += `### 📈 详细数据\n\n`;
  report += `| Package | 今日 | 本周 | 本月 |\n`;
  report += `|---------|------|------|------|\n`;

  sortedStats.forEach(stat => {
    const prev = previousStats?.[stat.name];
    const dayGrowth = prev ? calculateGrowth(stat.lastDay, prev.lastDay) : null;
    const weekGrowth = prev ? calculateGrowth(stat.lastWeek, prev.lastWeek) : null;
    const monthGrowth = prev ? calculateGrowth(stat.lastMonth, prev.lastMonth) : null;
    
    const dayStr = stat.lastDay.toLocaleString() + (dayGrowth ? ` ${formatGrowth(dayGrowth)}` : '');
    const weekStr = stat.lastWeek.toLocaleString() + (weekGrowth ? ` ${formatGrowth(weekGrowth)}` : '');
    const monthStr = stat.lastMonth.toLocaleString() + (monthGrowth ? ` ${formatGrowth(monthGrowth)}` : '');
    
    report += `| \`${stat.name}\` | ${dayStr} | ${weekStr} | ${monthStr} |\n`;
  });

  report += `\n---\n\n`;
  report += `*由 [npm-crawler](https://github.com/${github.context.repo.owner}/${github.context.repo.repo}) 自动生成*`;

  return report;
}

/**
 * 获取上一次的 Issue 统计数据
 */
async function getPreviousIssueStats(octokit, currentDate) {
  try {
    const { owner, repo } = github.context.repo;
    
    // 获取所有带 npm-stats 标签的 Issue
    const { data: issues } = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'all', // 包括已关闭的
      labels: 'npm-stats',
      per_page: 30,
      sort: 'created',
      direction: 'desc'
    });

    // 找到当前日期之前的最近一个 Issue
    const currentDateObj = new Date(currentDate);
    for (const issue of issues) {
      // 从标题中提取日期
      const dateMatch = issue.title.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const issueDate = new Date(dateMatch[1]);
        if (issueDate < currentDateObj) {
          // 获取 Issue 的完整内容
          const { data: fullIssue } = await octokit.rest.issues.get({
            owner,
            repo,
            issue_number: issue.number
          });
          
          if (fullIssue.body) {
            const previousStats = parsePreviousStats(fullIssue.body);
            if (Object.keys(previousStats).length > 0) {
              core.info(`Found previous stats from issue #${issue.number} (${dateMatch[1]})`);
              return previousStats;
            }
          }
        }
      }
    }
    
    return null;
  } catch (error) {
    core.warning(`Failed to get previous issue stats: ${error.message}`);
    return null;
  }
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
      
      // 添加评论以触发通知（GitHub 会在创建 Issue 时发送通知，但添加评论可以确保通知）
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: '📊 今日 npm 下载量统计报告已生成！'
      });
      
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

    // 获取 GitHub token
    const token = core.getInput('github_token') || process.env.GITHUB_TOKEN;
    if (!token) {
      core.setFailed('GITHUB_TOKEN is required');
      return;
    }

    const octokit = github.getOctokit(token);
    const today = new Date().toISOString().split('T')[0];

    // 获取上一次的统计数据用于计算增长
    core.info('🔍 Fetching previous stats for comparison...');
    const previousStats = await getPreviousIssueStats(octokit, today);
    if (previousStats) {
      core.info('Found previous stats for comparison');
    } else {
      core.info('No previous stats found (this might be the first run)');
    }

    // 生成报告（包含增长数据）
    const report = generateReport(stats, today, previousStats);
    core.info('📝 Report generated');

    // 创建 Issue
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

