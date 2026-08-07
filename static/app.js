/**
 * 歌单导入器 — 前端逻辑
 */
(function () {
  'use strict';

  // ==================== API 基础路径 ====================
  var pathParts = window.location.pathname.split('/');
  var pluginIdx = pathParts.indexOf('playlist-importer');
  var basePath = pluginIdx >= 0
    ? pathParts.slice(0, pluginIdx + 1).join('/')
    : '/api/v1/jsplugin/playlist-importer';
  var API_BASE = basePath + '/api';

  // ==================== 工具函数 ====================
  function api(path, method, body) {
    var opts = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(API_BASE + path, opts).then(function (r) { return r.json(); });
  }

  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function formatDuration(sec) {
    if (!sec || sec < 0) return '--:--';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ==================== Tab 切换 ====================
  var tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tab = btn.dataset.tab;
      tabBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
      $('tab-' + tab).classList.add('active');
    });
  });

  // ==================== 配置加载 ====================
  function loadConfig() {
    api('/config', 'GET').then(function (res) {
      if (!res.success || !res.config) return;
      var c = res.config;
      $('cfg-url').value = c.luoxueApiUrl || '';
      $('cfg-pass').value = c.luoxueApiPass || '';
      $('cfg-mode').value = c.importMode || 'download';
      $('cfg-quality').value = c.defaultQuality || '320k';
      $('cfg-source').value = c.defaultSearchSource || 'kw';
    }).catch(function (e) { console.error('加载配置失败:', e); });
  }

  // ==================== 配置保存 ====================
  $('btn-save-config').addEventListener('click', function () {
    var config = {
      luoxueApiUrl: $('cfg-url').value.trim(),
      luoxueApiPass: $('cfg-pass').value,
    };
    api('/config', 'POST', config).then(function (res) {
      if (res.success) {
        hide($('test-result'));
        alert('设置已保存');
      } else {
        alert('保存失败: ' + (res.error || '未知错误'));
      }
    }).catch(function (e) { alert('保存失败: ' + e); });
  });

  $('btn-save-options').addEventListener('click', function () {
    var config = {
      importMode: $('cfg-mode').value,
      defaultQuality: $('cfg-quality').value,
      defaultSearchSource: $('cfg-source').value,
    };
    api('/config', 'POST', config).then(function (res) {
      if (res.success) {
        alert('选项已保存');
      } else {
        alert('保存失败: ' + (res.error || '未知错误'));
      }
    }).catch(function (e) { alert('保存失败: ' + e); });
  });

  // ==================== 测试洛雪连接 ====================
  $('btn-test').addEventListener('click', function () {
    var btn = $('btn-test');
    btn.disabled = true;
    btn.textContent = '测试中...';
    var resultEl = $('test-result');
    hide(resultEl);

    var config = {
      luoxueApiUrl: $('cfg-url').value.trim(),
      luoxueApiPass: $('cfg-pass').value,
    };
    api('/config', 'POST', config).then(function () {
      return api('/test-luoxue', 'POST');
    }).then(function (res) {
      show(resultEl);
      if (res.ok) {
        resultEl.className = 'test-result success';
        resultEl.textContent = res.message || '连接正常';
      } else {
        resultEl.className = 'test-result fail';
        resultEl.textContent = res.message || '连接失败';
      }
    }).catch(function (e) {
      show(resultEl);
      resultEl.className = 'test-result fail';
      resultEl.textContent = '测试失败: ' + e;
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = '测试连接';
    });
  });

  // ==================== 预览歌单 ====================
  $('btn-preview').addEventListener('click', function () {
    var text = $('share-input').value.trim();
    if (!text) { alert('请先粘贴分享链接'); return; }

    var btn = $('btn-preview');
    btn.disabled = true;
    btn.textContent = '预览中...';
    hide($('preview-section'));

    api('/preview', 'POST', { text: text }).then(function (res) {
      if (!res.success) {
        alert(res.error || '预览失败');
        return;
      }
      renderPreview(res.parsed, res.playlist);
    }).catch(function (e) {
      alert('预览失败: ' + e);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = '预览歌单';
    });
  });

  function renderPreview(parsed, playlist) {
    var infoEl = $('preview-info');
    var tracksEl = $('preview-tracks');

    var platformNames = {
      netease: '网易云音乐', qqmusic: 'QQ音乐',
      kuwo: '酷我音乐', kugou: '酷狗音乐',
      qishui: '汽水音乐',
    };

    var html = '';
    if (playlist.coverUrl) {
      html += '<img src="' + escapeHtml(playlist.coverUrl) + '" onerror="this.style.display=\'none\'">';
    }
    html += '<div class="info-text">';
    html += '<div class="info-name">' + escapeHtml(playlist.name) + '</div>';
    html += '<div class="info-meta">';
    html += platformNames[playlist.platform] || playlist.platform;
    html += ' · ' + playlist.trackCount + ' 首';
    if (playlist.creator) html += ' · by ' + escapeHtml(playlist.creator);
    html += '</div></div>';
    infoEl.innerHTML = html;

    var tracksHtml = '';
    var tracks = playlist.previewTracks || [];
    tracks.forEach(function (t, i) {
      tracksHtml += '<div class="track-item">';
      tracksHtml += '<span class="track-num">' + (i + 1) + '</span>';
      tracksHtml += '<span class="track-title">' + escapeHtml(t.title) + '</span>';
      tracksHtml += '<span class="track-artist">' + escapeHtml(t.artist) + '</span>';
      if (t.duration) tracksHtml += '<span class="track-duration">' + formatDuration(t.duration) + '</span>';
      tracksHtml += '</div>';
    });
    if (tracks.length < playlist.trackCount) {
      tracksHtml += '<div class="track-item" style="justify-content:center;color:var(--text-muted)">';
      tracksHtml += '还有 ' + (playlist.trackCount - tracks.length) + ' 首...</div>';
    }
    tracksEl.innerHTML = tracksHtml;

    show($('preview-section'));
  }

  // ==================== 导入歌单 ====================
  var pollTimer = null;

  $('btn-import').addEventListener('click', function () {
    var text = $('share-input').value.trim();
    if (!text) { alert('请先粘贴分享链接'); return; }

    var btn = $('btn-import');
    btn.disabled = true;
    btn.textContent = '导入中...';
    hide($('preview-section'));
    show($('progress-section'));
    updateProgressUI({
      total: 0, current: 0, status: 'parsing',
      message: '正在启动导入任务...', errors: [], importedSongs: 0,
    });

    api('/import', 'POST', { text: text }).then(function (res) {
      if (!res.success) {
        alert(res.error || '导入失败');
        btn.disabled = false;
        btn.textContent = '开始导入';
        hide($('progress-section'));
        return;
      }
      startPolling();
    }).catch(function (e) {
      alert('导入失败: ' + e);
      btn.disabled = false;
      btn.textContent = '开始导入';
      hide($('progress-section'));
    });
  });

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1000);
    pollStatus();
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollStatus() {
    api('/status', 'GET').then(function (res) {
      if (!res.success || !res.progress) {
        stopPolling();
        return;
      }
      updateProgressUI(res.progress);

      if (res.progress.status === 'done' || res.progress.status === 'error') {
        stopPolling();
        var btn = $('btn-import');
        btn.disabled = false;
        btn.textContent = '开始导入';
      }
    }).catch(function (e) {
      console.error('轮询进度失败:', e);
    });
  }

  function updateProgressUI(p) {
    var percent = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
    $('progress-bar').style.width = percent + '%';

    var statusMap = {
      parsing: '解析链接中...',
      fetching: '抓取歌单中...',
      downloading: '下载中...',
      importing: '导入中...',
      done: '导入完成',
      error: '导入失败',
    };
    $('progress-text').textContent = p.message || statusMap[p.status] || '处理中...';
    $('progress-count').textContent = p.total > 0
      ? p.current + ' / ' + p.total + ' (' + p.importedSongs + ' 成功)'
      : '';

    $('progress-current').textContent = p.currentTrack || '';

    var errEl = $('progress-errors');
    if (p.errors && p.errors.length > 0) {
      show(errEl);
      errEl.innerHTML = p.errors.map(function (e) {
        return '<div class="error-item">' + escapeHtml(e) + '</div>';
      }).join('');
    } else {
      hide(errEl);
    }
  }

  // ==================== 加载支持平台 ====================
  function loadPlatforms() {
    api('/platforms', 'GET').then(function (res) {
      if (!res.success || !res.platforms) return;
      var html = res.platforms.map(function (p) {
        return '<span class="platform-badge">' + escapeHtml(p.name) + '</span>';
      }).join('');
      $('platform-list').innerHTML = html;
    }).catch(function () { /* 忽略 */ });
  }

  // ==================== 初始化 ====================
  loadConfig();
  loadPlatforms();
})();
