#!/usr/bin/env bash
# 推送到 GitHub（在能访问 github.com 的机器上运行）
#
# 用法:
#   GITHUB_USER=<你的GitHub用户名> GITHUB_PAT=<你的Fine-grained PAT> ./push.sh [分支名]
#
# 说明:
#   - 修复已在本仓库本地提交（commit 见 git log）
#   - origin 已指向 https://github.com/0klaus0/songloft-plugin-playlist-importer.git
#   - 若你习惯用 SSH，可直接: git push origin <分支>
set -e

REPO="0klaus0/songloft-plugin-playlist-importer"
BRANCH="${3:-${2:-${1:-master}}}"

: "${GITHUB_USER:?请提供 GitHub 用户名: GITHUB_USER=xxx GITHUB_PAT=xxx ./push.sh}"
: "${GITHUB_PAT:?请提供 Fine-grained PAT: GITHUB_USER=xxx GITHUB_PAT=xxx ./push.sh}"

echo "==> 推送 ${BRANCH} 到 ${REPO} ..."
git push "https://${GITHUB_USER}:${GITHUB_PAT}@github.com/${REPO}.git" "${BRANCH}"

echo "==> 完成。可在 https://github.com/${REPO} 查看提交与 CI 构建状态"
