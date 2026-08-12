/**
 * 歌单导入器 — 前端逻辑（含自定义音源管理 + 逐源检测，兼容洛雪音源脚本）
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
    return fetch(API_BASE + path, opts).then(function (r) {
      return r.text().then(function (text) {
        if (!text || text.trim() === '') {
          throw new Error('服务器返回空响应（可能请求超时或内部错误）');
        }
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error('服务器返回了无效的 JSON: ' + text.substring(0, 200));
        }
      });
    });
  }

  function $(id) { return document.getElementById(id); }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  function formatDuration(sec) {
    if (!sec || sec < 0) return '--:--';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '<', '>': '>', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showToast(message, type) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'toast' + (type === 'error' ? ' toast-error' : ' toast-success');
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(function () {
      toast.classList.add('toast-show');
    });

    setTimeout(function () {
      toast.classList.remove('toast-show');
      setTimeout(function () { toast.remove(); }, 300);
    }, 2800);
  }

  // ==================== Tab 切换 ====================
  var tabBtns = document.querySelectorAll('.tab-btn');
  for (var i = 0; i < tabBtns.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.dataset.tab;
        for (var j = 0; j < tabBtns.length; j++) {
          tabBtns[j].classList.remove('active');
        }
        btn.classList.add('active');

        var contents = document.querySelectorAll('.tab-content');
        for (var k = 0; k < contents.length; k++) {
          contents[k].classList.remove('active');
        }
        var target = $('tab-' + tab);
        if (target) {
          target.classList.add('active');
        }
      });
    })(tabBtns[i]);
  }

  // ==================== 配置加载 ====================
  // 自定义音源 URL 列表（运行时状态）
  var sourceUrls = [];
  // 已上传的本地脚本文件（运行时状态）：{ id, name }
  var fileSources = [];

  function loadConfig() {
    api('/config', 'GET').then(function (res) {
      if (!res.success || !res.config) return;
      var c = res.config;
      var useBuiltin = c.useBuiltinSource !== false;
      if ($('cfg-mode-builtin')) $('cfg-mode-builtin').checked = useBuiltin;
      if ($('cfg-mode-external')) $('cfg-mode-external').checked = !useBuiltin;
      toggleSourceFields();
      if ($('cfg-url')) $('cfg-url').value = c.luoxueApiUrl || '';
      if ($('cfg-pass')) $('cfg-pass').value = c.luoxueApiPass || '';
      // 拆分 customSources 为 URL 列表与上传文件列表
      var cs = Array.isArray(c.customSources) ? c.customSources : [];
      sourceUrls = cs.filter(function (s) { return s.kind === 'url'; }).map(function (s) { return s.value; });
      fileSources = cs.filter(function (s) { return s.kind === 'file'; }).map(function (s) { return { id: s.value, name: s.name }; });
      renderSourceList();
      renderUploadedList();
      if ($('cfg-builtin-source')) $('cfg-builtin-source').value = c.defaultSearchSource || 'kw';
      if ($('cfg-external-source')) $('cfg-external-source').value = c.defaultSearchSource || 'kw';
      if ($('cfg-mode')) $('cfg-mode').value = c.importMode || 'stream';
      if ($('cfg-quality')) $('cfg-quality').value = c.defaultQuality || '320k';
    }).catch(function (e) { console.error('加载配置失败:', e); });
  }

  // ==================== 音源列表管理 ====================
  function renderSourceList() {
    var listEl = $('source-list');
    if (!listEl) return;
    if (sourceUrls.length === 0) {
      listEl.innerHTML = '<div class="source-empty">暂无自定义音源，在下方添加</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < sourceUrls.length; i++) {
      html += '<div class="source-item">';
      html += '<span class="source-num">' + (i + 1) + '</span>';
      html += '<span class="source-url" title="' + escapeHtml(sourceUrls[i]) + '">' + escapeHtml(sourceUrls[i]) + '</span>';
      html += '<button class="source-del" data-idx="' + i + '" type="button" title="删除">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
      html += '</button>';
      html += '</div>';
    }
    listEl.innerHTML = html;
    // 绑定删除按钮
    var delBtns = listEl.querySelectorAll('.source-del');
    for (var j = 0; j < delBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var idx = parseInt(btn.dataset.idx, 10);
          sourceUrls.splice(idx, 1);
          renderSourceList();
        });
      })(delBtns[j]);
    }
  }

  if ($('btn-add-source')) {
    $('btn-add-source').addEventListener('click', function () {
      addSourceUrl();
    });
  }
  if ($('cfg-source-input')) {
    $('cfg-source-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        addSourceUrl();
      }
    });
  }

  function addSourceUrl() {
    var input = $('cfg-source-input');
    if (!input) return;
    var url = input.value.trim();
    if (!url) { showToast('请输入音源 URL', 'error'); return; }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      showToast('URL 必须以 http:// 或 https:// 开头', 'error');
      return;
    }
    // 去重
    if (sourceUrls.indexOf(url) >= 0) {
      showToast('该音源已存在', 'error');
      return;
    }
    sourceUrls.push(url);
    input.value = '';
    renderSourceList();
    showToast('音源已添加');
  }

  function getCustomSourceUrls() {
    return sourceUrls.slice();
  }

  // ==================== 已上传脚本管理 ====================
  function renderUploadedList() {
    var listEl = $('uploaded-list');
    if (!listEl) return;
    if (fileSources.length === 0) {
      listEl.innerHTML = '<div class="source-empty">尚未上传本地脚本，选择一个 .js 文件上传</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < fileSources.length; i++) {
      html += '<div class="source-item">';
      html += '<span class="source-num">' + (i + 1) + '</span>';
      html += '<span class="source-url" title="' + escapeHtml(fileSources[i].name) + '">' + escapeHtml(fileSources[i].name) + '</span>';
      html += '<button class="source-del" data-id="' + escapeHtml(fileSources[i].id) + '" type="button" title="删除">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
      html += '</button>';
      html += '</div>';
    }
    listEl.innerHTML = html;
    var delBtns = listEl.querySelectorAll('.source-del');
    for (var j = 0; j < delBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.dataset.id;
          api('/delete-source', 'POST', { id: id }).then(function () {
            fileSources = fileSources.filter(function (f) { return f.id !== id; });
            renderUploadedList();
            showToast('已删除脚本');
          }).catch(function (e) { showToast('删除失败: ' + e, 'error'); });
        });
      })(delBtns[j]);
    }
  }

  if ($('btn-upload-source')) {
    $('btn-upload-source').addEventListener('click', function () {
      var input = $('cfg-source-file');
      if (!input) return;
      var file = input.files && input.files[0];
      if (!file) { showToast('请先选择一个 .js 文件', 'error'); return; }
      if (!/\.js$/i.test(file.name) && file.type !== 'application/javascript' && file.type !== 'text/javascript') {
        showToast('请选择 .js 音源脚本文件', 'error');
        return;
      }
      var btn = $('btn-upload-source');
      btn.disabled = true;
      // 以原始字节发送（不包裹 JSON）
      fetch(API_BASE + '/upload-source?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        body: file,
      }).then(function (r) {
        return r.text().then(function (text) {
          if (!text) throw new Error('空响应');
          return JSON.parse(text);
        });
      }).then(function (res) {
        if (res.success) {
          fileSources.push({ id: res.id, name: res.name });
          renderUploadedList();
          input.value = '';
          showToast('脚本已上传: ' + res.name);
        } else {
          showToast('上传失败: ' + (res.error || '未知错误'), 'error');
        }
      }).catch(function (e) { showToast('上传失败: ' + e, 'error'); })
        .finally(function () { btn.disabled = false; });
    });
  }

  // ==================== 音源模式切换 ====================
  function toggleSourceFields() {
    var builtinRadio = $('cfg-mode-builtin');
    var builtinFields = $('builtin-source-fields');
    var externalFields = $('external-source-fields');
    var hint = $('source-mode-hint');
    if (!builtinRadio || !builtinFields || !externalFields) return;

    if (builtinRadio.checked) {
      show(builtinFields);
      hide(externalFields);
      if (hint) hint.textContent = '通过洛雪音源脚本解析音乐 URL，可添加多个脚本（推荐）';
    } else {
      hide(builtinFields);
      show(externalFields);
      if (hint) hint.textContent = '使用自行部署的洛雪音源 API 服务器获取音乐链接';
    }
  }

  if ($('cfg-mode-builtin')) {
    $('cfg-mode-builtin').addEventListener('change', toggleSourceFields);
  }
  if ($('cfg-mode-external')) {
    $('cfg-mode-external').addEventListener('change', toggleSourceFields);
  }

  // ==================== 获取当前搜索来源 ====================
  function getCurrentSearchSource() {
    var useBuiltin = $('cfg-mode-builtin') ? $('cfg-mode-builtin').checked : true;
    if (useBuiltin) {
      return $('cfg-builtin-source') ? $('cfg-builtin-source').value : 'kw';
    }
    return $('cfg-external-source') ? $('cfg-external-source').value : 'kw';
  }

  // ==================== 配置保存 ====================
  if ($('btn-save-config')) {
    $('btn-save-config').addEventListener('click', function () {
      var useBuiltin = $('cfg-mode-builtin') ? $('cfg-mode-builtin').checked : true;
      // 合并 URL 与上传文件为统一 customSources
      var customSources = [];
      for (var i = 0; i < sourceUrls.length; i++) {
        customSources.push({ kind: 'url', value: sourceUrls[i], name: sourceUrls[i] });
      }
      for (var j = 0; j < fileSources.length; j++) {
        customSources.push({ kind: 'file', value: fileSources[j].id, name: fileSources[j].name });
      }
      var config = {
        useBuiltinSource: useBuiltin,
        luoxueApiUrl: useBuiltin ? '' : ($('cfg-url') ? $('cfg-url').value.trim() : ''),
        luoxueApiPass: useBuiltin ? '' : ($('cfg-pass') ? $('cfg-pass').value : ''),
        customSources: customSources,
        defaultSearchSource: getCurrentSearchSource(),
        defaultQuality: $('cfg-quality') ? $('cfg-quality').value : '320k',
      };
      api('/config', 'POST', config).then(function (res) {
        if (res.success) {
          hide($('test-result'));
          showToast('设置已保存');
        } else {
          showToast('保存失败: ' + (res.error || '未知错误'), 'error');
        }
      }).catch(function (e) { showToast('保存失败: ' + e, 'error'); });
    });
  }

  if ($('btn-save-options')) {
    $('btn-save-options').addEventListener('click', function () {
      var config = {
        importMode: $('cfg-mode') ? $('cfg-mode').value : 'stream',
      };
      api('/config', 'POST', config).then(function (res) {
        if (res.success) {
          showToast('选项已保存');
        } else {
          showToast('保存失败: ' + (res.error || '未知错误'), 'error');
        }
      }).catch(function (e) { showToast('保存失败: ' + e, 'error'); });
    });
  }

  // ==================== 测试洛雪连接 ====================
  if ($('btn-test')) {
    $('btn-test').addEventListener('click', function () {
      var btn = $('btn-test');
      btn.disabled = true;
      var spanEl = btn.querySelector('span');
      var originalText = spanEl ? spanEl.textContent : '测试连接';
      if (spanEl) spanEl.textContent = '测试中...';
      var resultEl = $('test-result');
      hide(resultEl);

      var useBuiltin = $('cfg-mode-builtin') ? $('cfg-mode-builtin').checked : true;
      var customSources = [];
      for (var ci = 0; ci < sourceUrls.length; ci++) {
        customSources.push({ kind: 'url', value: sourceUrls[ci], name: sourceUrls[ci] });
      }
      for (var cj = 0; cj < fileSources.length; cj++) {
        customSources.push({ kind: 'file', value: fileSources[cj].id, name: fileSources[cj].name });
      }
      var config = {
        useBuiltinSource: useBuiltin,
        luoxueApiUrl: useBuiltin ? '' : ($('cfg-url') ? $('cfg-url').value.trim() : ''),
        luoxueApiPass: useBuiltin ? '' : ($('cfg-pass') ? $('cfg-pass').value : ''),
        customSources: customSources,
        defaultSearchSource: getCurrentSearchSource(),
        defaultQuality: $('cfg-quality') ? $('cfg-quality').value : '320k',
      };
      api('/config', 'POST', config).then(function () {
        return api('/test-luoxue', 'POST');
      }).then(function (res) {
        show(resultEl);
        if (res.ok) {
          resultEl.className = 'test-result success';
          resultEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>' + escapeHtml(res.message || '连接正常');
        } else {
          resultEl.className = 'test-result fail';
          resultEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' + escapeHtml(res.message || '连接失败');
        }
        renderPlatformGrid(res.platforms);
      }).catch(function (e) {
        show(resultEl);
        resultEl.className = 'test-result fail';
        resultEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>测试失败: ' + escapeHtml(String(e));
      }).finally(function () {
        btn.disabled = false;
        if (spanEl) spanEl.textContent = originalText;
      });
    });
  }

  // ==================== 预览歌单 ====================
  if ($('btn-preview')) {
    $('btn-preview').addEventListener('click', function () {
      var text = $('share-input').value.trim();
      if (!text) { showToast('请先粘贴分享链接', 'error'); return; }

      var btn = $('btn-preview');
      btn.disabled = true;
      var spanEl = btn.querySelector('span');
      var originalText = spanEl ? spanEl.textContent : '预览歌单';
      if (spanEl) spanEl.textContent = '预览中...';
      hide($('preview-section'));

      api('/preview', 'POST', { text: text }).then(function (res) {
        if (!res.success) {
          showToast(res.error || '预览失败', 'error');
          return;
        }
        renderPreview(res.parsed, res.playlist);
      }).catch(function (e) {
        showToast('预览失败: ' + e, 'error');
      }).finally(function () {
        btn.disabled = false;
        if (spanEl) spanEl.textContent = originalText;
      });
    });
  }

  function renderPreview(parsed, playlist) {
    var infoEl = $('preview-info');
    var tracksEl = $('preview-tracks');

    var platformNames = {
      netease: '网易云音乐', qqmusic: 'QQ音乐',
      kuwo: '酷我音乐', kugou: '酷狗音乐',
      qishui: '汽水音乐',
    };

    var html = '<div class="preview-info">';
    if (playlist.coverUrl) {
      html += '<img src="' + escapeHtml(playlist.coverUrl) + '" onerror="this.style.display=\'none\'">';
    }
    html += '<div class="info-text">';
    html += '<div class="info-name">' + escapeHtml(playlist.name) + '</div>';
    html += '<div class="info-meta">';
    html += platformNames[playlist.platform] || playlist.platform;
    html += ' · ' + playlist.trackCount + ' 首';
    if (playlist.creator) html += ' · ' + escapeHtml(playlist.creator);
    html += '</div></div></div>';

    var tracksHtml = '<div class="track-list">';
    var tracks = playlist.previewTracks || [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      tracksHtml += '<div class="track-item">';
      tracksHtml += '<span class="track-num">' + (i + 1) + '</span>';
      tracksHtml += '<span class="track-title">' + escapeHtml(t.title) + '</span>';
      tracksHtml += '<span class="track-artist">' + escapeHtml(t.artist) + '</span>';
      if (t.duration) tracksHtml += '<span class="track-duration">' + formatDuration(t.duration) + '</span>';
      tracksHtml += '</div>';
    }
    if (tracks.length < playlist.trackCount) {
      tracksHtml += '<div class="track-item" style="justify-content:center;color:var(--text-muted)">';
      tracksHtml += '还有 ' + (playlist.trackCount - tracks.length) + ' 首...</div>';
    }
    tracksHtml += '</div>';

    infoEl.innerHTML = html;
    tracksEl.innerHTML = tracksHtml;
    show($('preview-section'));
  }

  // ==================== 导入歌单 ====================
  var pollTimer = null;
  var importBtnOriginalText = '开始导入';

  function setImportBtnDisabled(disabled) {
    var btn = $('btn-import');
    if (!btn) return;
    btn.disabled = disabled;
    var spanEl = btn.querySelector('span');
    if (spanEl) {
      spanEl.textContent = disabled ? '导入中...' : importBtnOriginalText;
    }
  }

  if ($('btn-import')) {
    $('btn-import').addEventListener('click', function () {
      var text = $('share-input').value.trim();
      if (!text) { showToast('请先粘贴分享链接', 'error'); return; }

      setImportBtnDisabled(true);
      hide($('preview-section'));
      show($('progress-section'));
      updateProgressUI({
        total: 0, current: 0, status: 'parsing',
        message: '正在启动导入任务...', errors: [], importedSongs: 0,
        streamingSongs: 0, downloadedSongs: 0,
      });

      api('/import', 'POST', { text: text }).then(function (res) {
        if (!res.success) {
          showToast(res.error || '导入失败', 'error');
          setImportBtnDisabled(false);
          hide($('progress-section'));
          return;
        }
        // 已有任务正在进行 — 直接显示当前进度并开始轮询
        if (res.alreadyRunning && res.progress) {
          updateProgressUI(res.progress);
        }
        startPolling();
      }).catch(function (e) {
        showToast('导入失败: ' + e, 'error');
        setImportBtnDisabled(false);
        hide($('progress-section'));
      });
    });
  }

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
        setImportBtnDisabled(false);
        return;
      }
      updateProgressUI(res.progress);

      if (res.progress.status === 'done' || res.progress.status === 'error') {
        stopPolling();
        setImportBtnDisabled(false);
        if (res.progress.status === 'done') {
          showToast('导入完成');
        }
      }
    }).catch(function (e) {
      console.error('轮询进度失败:', e);
    });
  }

  function updateProgressUI(p) {
    // 阶段 1（解析音源）使用 resolveTotal/resolveCurrent，阶段 2（下载）使用 total/current
    var isResolving = p.phase === 'resolving';
    var displayTotal = isResolving ? (p.resolveTotal || p.total) : p.total;
    var displayCurrent = isResolving ? (p.resolveCurrent || p.current) : p.current;
    var percent = displayTotal > 0 ? Math.round((displayCurrent / displayTotal) * 100) : 0;
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

    // 构建计数文字：显示当前进度 + 成功数 + 下载/串流明细
    var countParts = [];
    if (displayTotal > 0) {
      countParts.push(displayCurrent + ' / ' + displayTotal);
    }
    if (p.importedSongs > 0) {
      countParts.push(p.importedSongs + ' 成功');
    }
    if (p.downloadedSongs > 0) {
      countParts.push(p.downloadedSongs + ' 已下载');
    }
    if (p.streamingSongs > 0) {
      countParts.push(p.streamingSongs + ' 串流');
    }
    if (p.errors && p.errors.length > 0) {
      countParts.push(p.errors.length + ' 失败');
    }
    $('progress-count').textContent = countParts.join(' · ');

    $('progress-current').textContent = p.currentTrack || '';

    // 导入完成时显示总结
    if (p.status === 'done' && p.message) {
      $('progress-text').textContent = p.message;
    }

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
      if ($('platform-list')) $('platform-list').innerHTML = html;
    }).catch(function () { /* 忽略 */ });
  }

  // ==================== 渲染按平台状态网格 ====================
  var PF_STATUS_TEXT = {
    ok: '正常',
    fail: '不可用',
    unsupported: '未启用',
    unreachable: '不可达',
  };
  function renderPlatformGrid(platforms) {
    var grid = $('platform-grid');
    if (!grid) return;
    if (!platforms || platforms.length === 0) {
      grid.innerHTML = '<div class="pf-empty">暂无检测数据，点“测试连接”后显示</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      var status = p.status || 'unreachable';
      var statusText = PF_STATUS_TEXT[status] || status;
      var reasonText = (status === 'fail' || status === 'unreachable') && p.reason ? p.reason : '';
      html += '<div class="pf-item ' + status + '" title="' + escapeHtml(reasonText || statusText) + '">';
      html += '<span class="pf-dot ' + status + '"></span>';
      html += '<div class="pf-info">';
      html += '<div class="pf-name">' + escapeHtml(p.name) + '</div>';
      html += '<div class="pf-status">' + escapeHtml(reasonText || statusText) + '</div>';
      html += '</div></div>';
    }
    grid.innerHTML = html;
  }

  // ==================== 初始化 ====================
  loadConfig();
  loadPlatforms();

  // 页面加载时检查是否有正在进行的导入任务
  api('/status', 'GET').then(function (res) {
    if (res.success && res.progress) {
      var p = res.progress;
      // 如果有正在进行的任务（非 done/error），显示进度面板并开始轮询
      if (p.status && p.status !== 'done' && p.status !== 'error') {
        // 切换到导入标签页，确保进度面板可见
        var importTabBtn = document.querySelector('.tab-btn[data-tab="import"]');
        if (importTabBtn) importTabBtn.click();
        show($('progress-section'));
        setImportBtnDisabled(true);
        updateProgressUI(p);
        startPolling();
      }
    }
  }).catch(function () {
    // 忽略
  });

  // ==================== 日志查看 ====================
  var logAutoRefresh = false;
  var logRefreshTimer = null;

  function formatLogTime(ts) {
    var d = new Date(ts);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function loadLogs() {
    api('/logs?limit=500', 'GET').then(function (res) {
      var container = $('log-container');
      if (!container) return;
      if (!res || !res.success || !res.logs || res.logs.length === 0) {
        container.innerHTML = '<div class="log-empty">暂无日志</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < res.logs.length; i++) {
        var log = res.logs[i];
        var levelClass = 'log-level-' + (log.level || 'info');
        var msgClass = 'log-msg' + (log.level === 'error' ? ' log-msg-error' : (log.level === 'warn' ? ' log-msg-warn' : ''));
        html += '<div class="log-line">' +
          '<span class="log-time">' + escapeHtml(formatLogTime(log.ts)) + '</span>' +
          '<span class="log-level ' + levelClass + '">' + escapeHtml(log.level || 'info') + '</span>' +
          '<span class="' + msgClass + '">' + escapeHtml(log.msg) + '</span>' +
          '</div>';
      }
      container.innerHTML = html;
      container.scrollTop = container.scrollHeight;
    }).catch(function () {
      // 忽略
    });
  }

  function clearLogs() {
    api('/logs/clear', 'POST', {}).then(function () {
      loadLogs();
      showToast('日志已清空');
    }).catch(function () {
      showToast('清空失败', 'error');
    });
  }

  function toggleAutoRefresh() {
    logAutoRefresh = !logAutoRefresh;
    var btn = $('btn-toggle-auto');
    if (logAutoRefresh) {
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
      logRefreshTimer = setInterval(loadLogs, 3000);
      loadLogs();
    } else {
      btn.classList.add('btn-secondary');
      btn.classList.remove('btn-primary');
      if (logRefreshTimer) {
        clearInterval(logRefreshTimer);
        logRefreshTimer = null;
      }
    }
  }

  if ($('btn-refresh-logs')) {
    $('btn-refresh-logs').addEventListener('click', loadLogs);
  }
  if ($('btn-clear-logs')) {
    $('btn-clear-logs').addEventListener('click', clearLogs);
  }
  if ($('btn-toggle-auto')) {
    $('btn-toggle-auto').addEventListener('click', toggleAutoRefresh);
  }
})();
