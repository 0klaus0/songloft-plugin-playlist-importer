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
  // 自定义音源列表（运行时状态）：[{ index, kind, value, name, enabled, author, version, description, platforms }]
  var sources = [];

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
      if ($('cfg-builtin-source')) $('cfg-builtin-source').value = c.defaultSearchSource || 'kw';
      if ($('cfg-external-source')) $('cfg-external-source').value = c.defaultSearchSource || 'kw';
      if ($('cfg-mode')) $('cfg-mode').value = c.importMode || 'stream';
      if ($('cfg-quality')) $('cfg-quality').value = c.defaultQuality || '320k';
    }).catch(function (e) { console.error('加载配置失败:', e); });
  }

  // ==================== 自定义源管理 ====================
  var PLATFORM_SHORT = { kw: '酷我', kg: '酷狗', tx: 'QQ', wy: '网易', mg: '咪咕' };

  function loadSources() {
    api('/sources', 'GET').then(function (res) {
      if (res.success && Array.isArray(res.sources)) {
        sources = res.sources;
        renderSourceList();
      }
    }).catch(function (e) { console.error('加载音源失败:', e); });
  }

  function renderSourceList() {
    var listEl = $('source-manage-list');
    if (!listEl) return;
    if (sources.length === 0) {
      listEl.innerHTML = '<div class="source-empty">暂无自定义音源，点击上方按钮添加</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var enabled = s.enabled !== false;
      var name = s.name || (s.kind === 'url' ? s.value : '上传脚本');
      html += '<div class="source-card' + (enabled ? '' : ' disabled') + '" data-index="' + i + '">';
      html += '<span class="source-drag" title="拖拽排序"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg></span>';
      html += '<div class="source-card-body">';
      html += '<div class="source-name" title="' + escapeHtml(s.kind === 'url' ? s.value : name) + '">' + escapeHtml(name) + '</div>';
      html += '<div class="source-meta">';
      if (s.author) html += '<span class="src-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' + escapeHtml(s.author) + '</span>';
      if (s.version) html += '<span class="src-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>v' + escapeHtml(s.version) + '</span>';
      if (s.kind === 'file') html += '<span class="src-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>本地脚本</span>';
      html += '</div>';
      if (s.testScore !== undefined) {
        var scoreColor = s.testScore >= 80 ? '#34d399' : (s.testScore >= 50 ? '#fbc02d' : '#f87171');
        html += '<span class="src-score" style="background:' + scoreColor + ';color:#fff;padding:2px 6px;border-radius:10px;font-size:var(--font-size-xs);margin-left:8px;">' + s.testScore + '%</span>';
      }
      if (s.platforms && s.platforms.length > 0) {
        html += '<div class="source-platforms">';
        for (var p = 0; p < s.platforms.length; p++) {
          html += '<span class="source-platform-badge">' + escapeHtml(PLATFORM_SHORT[s.platforms[p]] || s.platforms[p]) + '</span>';
        }
        html += '</div>';
      }
      html += '</div>';
      html += '<div class="source-ctrl">';
      html += '<button class="source-test" data-index="' + i + '" type="button" title="测试该音源"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg></button>';
      html += '<button class="source-toggle' + (enabled ? ' on' : '') + '" data-index="' + i + '" type="button" title="' + (enabled ? '点击禁用' : '点击启用') + '"></button>';
      html += '<button class="source-del" data-index="' + i + '" type="button" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>';
      html += '</div>';
      html += '</div>';
    }
    listEl.innerHTML = html;
    bindSourceEvents(listEl);
  }

  function bindSourceEvents(listEl) {
    // 启用/禁用
    var toggles = listEl.querySelectorAll('.source-toggle');
    for (var i = 0; i < toggles.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var idx = parseInt(btn.dataset.index, 10);
          var s = sources[idx];
          if (!s) return;
          var newEnabled = !(s.enabled !== false);
          api('/sources/toggle', 'POST', { index: idx, enabled: newEnabled }).then(function (res) {
            if (res.success) {
              s.enabled = newEnabled;
              renderSourceList();
            } else {
              showToast(res.error || '操作失败', 'error');
            }
          }).catch(function (e) { showToast('操作失败: ' + e, 'error'); });
        });
      })(toggles[i]);
    }
    // 删除
    var dels = listEl.querySelectorAll('.source-del');
    for (var j = 0; j < dels.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var idx = parseInt(btn.dataset.index, 10);
          if (!window.confirm('确定删除该音源？')) return;
          api('/sources/delete', 'POST', { index: idx }).then(function (res) {
            if (res.success) {
              showToast('已删除');
              loadSources();
            } else {
              showToast(res.error || '删除失败', 'error');
            }
          }).catch(function (e) { showToast('删除失败: ' + e, 'error'); });
        });
      })(dels[j]);
    }
    // 单源测试
    var tests = listEl.querySelectorAll('.source-test');
    for (var t = 0; t < tests.length; t++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var idx = parseInt(btn.dataset.index, 10);
          testSingleSource(idx, btn);
        });
      })(tests[t]);
    }
    // 拖拽排序
    var cards = listEl.querySelectorAll('.source-card');
    var dragIndex = null;
    for (var k = 0; k < cards.length; k++) {
      (function (card) {
        card.setAttribute('draggable', 'true');
        card.addEventListener('dragstart', function (e) {
          dragIndex = parseInt(card.dataset.index, 10);
          card.classList.add('dragging');
          try { e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
        });
        card.addEventListener('dragend', function () {
          card.classList.remove('dragging');
        });
        card.addEventListener('dragover', function (e) {
          e.preventDefault();
          try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
        });
        card.addEventListener('drop', function (e) {
          e.preventDefault();
          if (dragIndex === null) return;
          var targetIndex = parseInt(card.dataset.index, 10);
          if (dragIndex === targetIndex) { renderSourceList(); return; }
          var moved = sources.splice(dragIndex, 1)[0];
          sources.splice(targetIndex, 0, moved);
          var order = sources.map(function (s) { return s.index; });
          api('/sources/reorder', 'POST', { order: order }).then(function (res) {
            if (!res.success) showToast(res.error || '排序保存失败', 'error');
            loadSources();
          }).catch(function () { loadSources(); });
        });
      })(cards[k]);
    }
  }

  // 当前音源列表（用于保存配置）
  function currentCustomSources() {
    return sources.map(function (s) {
      return { kind: s.kind, value: s.value, name: s.name };
    });
  }

  // URL 导入面板开关
  if ($('btn-url-import')) {
    $('btn-url-import').addEventListener('click', function () {
      var panel = $('url-import-panel');
      if (!panel) return;
      if (panel.classList.contains('hidden')) {
        show(panel);
        var input = $('cfg-source-input');
        if (input) input.focus();
      } else {
        hide(panel);
      }
    });
  }

  // 添加 URL 音源
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
    if (!/^https?:\/\//i.test(url)) {
      showToast('URL 必须以 http:// 或 https:// 开头', 'error');
      return;
    }
    var btn = $('btn-add-source');
    if (btn) btn.disabled = true;
    api('/sources/add-url', 'POST', { url: url }).then(function (res) {
      if (res.success) {
        input.value = '';
        hide($('url-import-panel'));
        showToast('音源已添加');
        loadSources();
      } else {
        showToast(res.error || '添加失败', 'error');
      }
    }).catch(function (e) { showToast('添加失败: ' + e, 'error'); })
      .finally(function () { if (btn) btn.disabled = false; });
  }

  // 上传脚本文件
  if ($('btn-upload-script')) {
    $('btn-upload-script').addEventListener('click', function () {
      var input = $('cfg-source-file');
      if (!input) return;
      var file = input.files && input.files[0];
      if (!file) { showToast('请先选择一个 .js 文件', 'error'); return; }
      if (!/\.js$/i.test(file.name) && file.type !== 'application/javascript' && file.type !== 'text/javascript') {
        showToast('请选择 .js 音源脚本文件', 'error');
        return;
      }
      var btn = $('btn-upload-script');
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
        if (!res.success) throw new Error(res.error || '上传失败');
        // 将上传的脚本加入配置
        var cs = currentCustomSources();
        cs.push({ kind: 'file', value: res.id, name: res.name });
        return api('/config', 'POST', { customSources: cs });
      }).then(function (res) {
        if (!res.success) throw new Error(res.error || '保存失败');
        input.value = '';
        showToast('脚本已上传并添加');
        loadSources();
      }).catch(function (e) { showToast('上传失败: ' + e, 'error'); })
        .finally(function () { btn.disabled = false; });
    });
  }

  // ==================== 音源模式切换 ====================
  function toggleSourceFields() {
    var builtinRadio = $('cfg-mode-builtin');
    var externalFields = $('external-source-fields');
    var hint = $('source-mode-hint');
    if (!builtinRadio || !externalFields) return;

    if (builtinRadio.checked) {
      hide(externalFields);
      if (hint) hint.textContent = '通过洛雪音源脚本解析音乐 URL，可添加多个脚本（推荐）';
    } else {
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
      var config = {
        useBuiltinSource: useBuiltin,
        luoxueApiUrl: useBuiltin ? '' : ($('cfg-url') ? $('cfg-url').value.trim() : ''),
        luoxueApiPass: useBuiltin ? '' : ($('cfg-pass') ? $('cfg-pass').value : ''),
        customSources: currentCustomSources(),
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

  // ==================== 测试洛雪连接（增强详细检测，类似洛雪逐源检测） ====================
  var ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>';
  var ICON_FAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  if ($('btn-test')) {
    $('btn-test').addEventListener('click', function () {
      var btn = $('btn-test');
      btn.disabled = true;
      var spanEl = btn.querySelector('span');
      var originalText = spanEl ? spanEl.textContent : '测试连接';
      if (spanEl) spanEl.textContent = '检测中...';
      var resultEl = $('test-result');
      hide(resultEl);

      // 立即弹出检测弹窗，显示"检测中"状态，再后台发起检测
      resolveModalHandlers();
      showTestModalLoading(countEnabledSources());

      var useBuiltin = $('cfg-mode-builtin') ? $('cfg-mode-builtin').checked : true;
      var config = {
        useBuiltinSource: useBuiltin,
        luoxueApiUrl: useBuiltin ? '' : ($('cfg-url') ? $('cfg-url').value.trim() : ''),
        luoxueApiPass: useBuiltin ? '' : ($('cfg-pass') ? $('cfg-pass').value : ''),
        customSources: currentCustomSources(),
        defaultSearchSource: getCurrentSearchSource(),
        defaultQuality: $('cfg-quality') ? $('cfg-quality').value : '320k',
      };
      api('/config', 'POST', config).then(function () {
        return api('/test-all-detail', 'POST', {});
      }).then(function (res) {
        show(resultEl);
        if (res.ok || (res.totOk || 0) > 0) {
          resultEl.className = 'test-result success';
          resultEl.innerHTML = ICON_OK + escapeHtml(res.msg || '连接正常');
        } else {
          resultEl.className = 'test-result fail';
          resultEl.innerHTML = ICON_FAIL + escapeHtml(res.msg || '无可用的音源脚本');
        }
        showTestAllModal(res);
        var all = [];
        if (res.sources) {
          for (var i = 0; i < res.sources.length; i++) {
            var sts = res.sources[i].statuses || [];
            for (var j = 0; j < sts.length; j++) all.push(sts[j]);
          }
        }
        renderPlatformGrid(all);
      }).catch(function (e) {
        show(resultEl);
        resultEl.className = 'test-result fail';
        resultEl.innerHTML = ICON_FAIL + escapeHtml('测试失败: ' + String(e));
        showTestModalError(String(e));
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

    // 填入默认歌单名（用户可修改）
    var nameInput = $('import-playlist-name');
    if (nameInput) {
      nameInput.value = '[导入] ' + (playlist.name || '');
    }

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

      var payload = { text: text };
      var nameInput = $('import-playlist-name');
      if (nameInput && nameInput.value.trim()) {
        payload.playlistName = nameInput.value.trim();
      }

      api('/import', 'POST', payload).then(function (res) {
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

  // 单源测试：调用后端测试指定音源，并把结果渲染到平台状态网格
  // 单源测试：调用后端详细检测指定音源，把评分/星级/平台延迟/诊断日志渲染到 modal（类似洛雪音源插件）
  function testSingleSource(idx, btn) {
    if (!btn) return;
    var originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('testing');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;animation:spin 1s linear infinite"><path d="M21 12a9 9 0 11-6.22-8.56"/></svg>';
    var modal = $('source-test-modal');
    var modalResult = $('modal-test-result');
    var modalGrid = $('modal-platform-grid');
    var starLine = $('modal-starline');
    var diagWrap = $('modal-diag-wrap');
    var diagLog = $('modal-diag-log');
    var diagToggle = $('modal-diag-toggle');
    resolveModalHandlers();
    api('/sources/test-detail', 'POST', { index: idx }).then(function (res) {
      btn.disabled = false;
      btn.classList.remove('testing');
      btn.innerHTML = originalHtml;
      if (!res.success) { showToast('检测失败: ' + (res.error || '未知错误'), 'error'); return; }
      if (!modal) { return; }
      var platforms = res.statuses || res.platforms || [];
      var okCount = res.okCount !== undefined ? res.okCount : 0;
      var testedCount = res.testedCount !== undefined ? res.testedCount : platforms.length;
      var score = res.score !== undefined ? res.score : 0;
      var starScore = res.starScore !== undefined ? res.starScore : 0;
      // 更新来源对象的测试结果
      if (sources && sources[idx]) {
        sources[idx].testScore = score;
        sources[idx].testStatus = res.ok ? 'ok' : 'fail';
        sources[idx].testMessage = res.msg || res.message || '';
        renderSourceList();
      }
      var msg = '可用 ' + okCount + '/' + testedCount + ' 个音源 (评分: ' + score + ')';
      if (modalResult) {
        if (res.ok || okCount > 0) {
          modalResult.className = 'test-result success';
          modalResult.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>' + escapeHtml(msg);
        } else {
          modalResult.className = 'test-result fail';
          modalResult.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' + escapeHtml(msg);
        }
      }
      // 星级评分
      if (starLine) {
        var starHtml = '';
        var fullStars = Math.floor(starScore);
        var halfStar = (starScore - fullStars) >= 0.5;
        var emptyStars = 5 - fullStars - (halfStar ? 1 : 0);
        for (var a = 0; a < fullStars; a++) starHtml += starSvg('');
        if (halfStar) starHtml += starSvg('', true);
        for (var b = 0; b < emptyStars; b++) starHtml += starSvg(' off');
        starLine.className = 'star-line';
        starLine.innerHTML = '<span class="sl-stars">' + starHtml + '</span><span class="sl-text">' + score + ' 分</span><span class="sl-count">' + okCount + '/' + testedCount + ' 个音源可用</span>';
      }
      // 平台状态网格（含延迟）
      if (modalGrid) renderPlatformGridToModal(platforms, modalGrid);
      // 诊断日志
      var logs = res.logs || [];
      if (diagWrap && diagLog && diagToggle) {
        if (logs.length > 0) {
          var logHtml = '';
          for (var li = 0; li < logs.length; li++) {
            var l = logs[li];
            var cls = 'dl-default';
            if (/\[error\]/.test(l)) cls = 'dl-error';
            else if (/\[warn\]/.test(l)) cls = 'dl-warn';
            logHtml += '<div class="' + cls + '">' + escapeHtml(l) + '</div>';
          }
          diagLog.innerHTML = logHtml;
          diagWrap.className = 'diag-wrap';
          diagToggle.textContent = '显示诊断日志 (' + logs.length + ')';
        } else {
          diagWrap.className = 'diag-wrap hidden';
        }
      }
      if (modal) modal.style.display = 'block';
    }).catch(function (e) {
      btn.disabled = false;
      btn.classList.remove('testing');
      btn.innerHTML = originalHtml;
      showToast('检测失败: ' + e, 'error');
    });
  }
  // 生成星级 SVG
  function starSvg(cls, half) {
    var p = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z';
    var o = half ? 'style="opacity:0.5"' : '';
    return '<svg class="' + cls + '" viewBox="0 0 24 24" ' + o + '><path d="' + p + '"/></svg>';
  }
  function starLineSvg(starScore) {
    var h = '';
    var full = Math.floor(starScore);
    var half = (starScore - full) >= 0.5;
    var empty = 5 - full - (half ? 1 : 0);
    for (var a = 0; a < full; a++) h += starSvg('');
    if (half) h += starSvg('', true);
    for (var b = 0; b < empty; b++) h += starSvg(' off');
    return h;
  }
  // 渲染单个来源的检测结果卡片（用于多来源弹窗）
  function renderSrcCard(s) {
    var ok = !!s.ok;
    var starHtml = starLineSvg(s.starScore !== undefined ? s.starScore : 0);
    var phtml = '';
    var sts = s.statuses || [];
    for (var p = 0; p < sts.length; p++) {
      var st = sts[p];
      var stText = PF_STATUS_TEXT[st.status] || st.status;
      var lat = (st.latencyMs !== undefined) ? '<span class="sdc-lat">' + st.latencyMs + 'ms</span>' : '';
      var reason = (st.status === 'fail' || st.status === 'unreachable') && st.reason ? st.reason : '';
      phtml += '<span class="sdc-chip ' + (st.status || '') + '" title="' + escapeHtml(reason || stText) + '"><span class="sdc-chip-name">' + escapeHtml(st.name) + '</span><span class="sdc-chip-status ' + (st.status || '') + '">' + escapeHtml(stText) + '</span>' + lat + '</span>';
    }
    var logs = s.logs || [];
    var diagBlock = '';
    var diagBtn = '';
    if (logs.length > 0) {
      var lhtml = '';
      for (var li = 0; li < logs.length; li++) {
        var l = logs[li];
        var cls = 'dl-default';
        if (/\[error\]/.test(l)) cls = 'dl-error';
        else if (/\[warn\]/.test(l)) cls = 'dl-warn';
        lhtml += '<div class="' + cls + '">' + escapeHtml(l) + '</div>';
      }
      diagBlock = '<div class="sdc-diag hidden"><div class="sdc-diag-log">' + lhtml + '</div></div>';
      diagBtn = '<button type="button" class="sdc-diag-btn">诊断日志 (' + logs.length + ')</button>';
    }
    var errNote = (!ok && s.initError) ? '<div class="sdc-err">' + escapeHtml(s.initError) + '</div>' : '';
    return '<div class="sdc-card ' + (ok ? 'sdc-ok' : 'sdc-fail') + '">' +
      '<div class="sdc-head">' +
        '<span class="sdc-badge ' + (ok ? 'ok' : 'fail') + '">' + (ok ? ICON_OK : ICON_FAIL) + '</span>' +
        '<div class="sdc-meta">' +
          '<div class="sdc-line1"><span class="sdc-name">' + escapeHtml(s.name) + '</span><span class="sdc-score">' + (s.score || 0) + ' 分</span><span class="sdc-count">' + (s.okCount || 0) + '/' + (s.testedCount || 0) + ' 可用</span></div>' +
          '<div class="sdc-stars">' + starHtml + '</div>' +
        '</div>' +
      '</div>' +
      errNote +
      (phtml ? '<div class="sdc-platforms">' + phtml + '</div>' : '') +
      (diagBtn ? '<div class="sdc-actions">' + diagBtn + '</div>' : '') +
      diagBlock +
    '</div>';
  }
  // 主"测试连接"：多来源增强检测弹窗（整体星级 + 逐源卡）
  function showTestAllModal(data) {
    var modal = $('source-test-modal');
    if (!modal) return;
    resolveModalHandlers();
    var srcs = data.sources || [];
    var modalResult = $('modal-test-result');
    if (modalResult) {
      modalResult.className = 'test-result ' + ((data.ok || (data.totOk || 0) > 0) ? 'success' : 'fail');
      modalResult.innerHTML = ((data.ok || (data.totOk || 0) > 0) ? ICON_OK : ICON_FAIL) + escapeHtml(data.msg || '');
    }
    var starLine = $('modal-starline');
    if (starLine) {
      starLine.className = 'star-line';
      starLine.innerHTML = '<span class="sl-stars">' + starLineSvg(data.starScore !== undefined ? data.starScore : 0) + '</span><span class="sl-text">' + (data.score || 0) + ' 分</span><span class="sl-count">' + (data.totOk || 0) + '/' + (data.totTested || 0) + ' 个音源可用</span>';
    }
    var listEl = $('modal-sources-list');
    if (listEl) {
      var html = '';
      if (srcs.length === 0) {
        html = '<div class="pf-empty">未启用任何音源脚本，或检测结果为空</div>';
      } else {
        for (var i = 0; i < srcs.length; i++) html += renderSrcCard(srcs[i]);
      }
      listEl.innerHTML = html;
      if (!listEl.__diagBound) {
        listEl.__diagBound = true;
        listEl.addEventListener('click', function (ev) {
          var t = ev.target;
          if (t && t.classList && t.classList.contains('sdc-diag-btn')) {
            var card = t.closest('.sdc-card');
            if (card) {
              var d = card.querySelector('.sdc-diag');
              if (d) {
                var isHidden = d.classList.contains('hidden');
                d.classList.toggle('hidden');
                var n = d.querySelector('.sdc-diag-log') ? d.querySelector('.sdc-diag-log').children.length : 0;
                if (t) t.textContent = isHidden ? '隐藏诊断日志' : '诊断日志 (' + n + ')';
              }
            }
          }
        });
      }
    }
    modal.style.display = 'block';
  }
  // 绑定弹窗关闭/遮罩/诊断日志切换：统一用 document 级事件委托，永久生效，
  // 不受弹窗内容被 innerHTML 重渲染的影响。
  var __modalHandlersBound = false;
  function resolveModalHandlers() {
    if (__modalHandlersBound) return;
    __modalHandlersBound = true;
    document.addEventListener('click', function (ev) {
      var modal = $('source-test-modal');
      if (!modal || modal.style.display !== 'block') return;
      var t = ev.target;
      if (t && t.classList && t.classList.contains('close') && modal.contains(t)) {
        modal.style.display = 'none';
        return;
      }
      if (t === modal) {
        modal.style.display = 'none';
        return;
      }
    });
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.classList || !t.classList.contains('diag-toggle')) return;
      var diagLog = $('modal-diag-log');
      if (!diagLog) return;
      var show = diagLog.classList.contains('hidden');
      if (show) { diagLog.classList.remove('hidden'); t.textContent = '隐藏诊断日志'; }
      else { diagLog.classList.add('hidden'); t.textContent = '显示诊断日志'; }
    });
  }
  // 获取启用的音源数量
  function countEnabledSources() {
    var n = 0;
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].enabled !== false) n++;
    }
    return n;
  }
  // 检测弹窗：加载中状态（点击测试连接后立即展示）
  function showTestModalLoading(enabledCount) {
    var modal = $('source-test-modal');
    if (!modal) return;
    var mr = $('modal-test-result');
    if (mr) {
      mr.className = 'test-result loading';
      mr.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;animation:spin 1s linear infinite;flex-shrink:0"><path d="M21 12a9 9 0 11-6.22-8.56"/></svg>正在检测，请稍候...';
    }
    var starLine = $('modal-starline');
    if (starLine) { starLine.className = 'star-line hidden'; starLine.innerHTML = ''; }
    var listEl = $('modal-sources-list');
    if (listEl) {
      var en = (enabledCount !== undefined && enabledCount >= 0) ? enabledCount : sources.length;
      listEl.innerHTML = '<div class="pf-empty">正在检测 ' + en + ' 个启用音源，请稍候...</div>';
    }
    var gridEl = $('modal-platform-grid');
    if (gridEl) gridEl.innerHTML = '<div class="pf-empty">检测中...</div>';
    var diagWrap = $('modal-diag-wrap');
    if (diagWrap) diagWrap.className = 'diag-wrap hidden';
    modal.style.display = 'block';
  }
  // 检测弹窗：检测出错时显示错误
  function showTestModalError(err) {
    var modal = $('source-test-modal');
    if (!modal) return;
    var mr = $('modal-test-result');
    if (mr) {
      mr.className = 'test-result fail';
      mr.innerHTML = ICON_FAIL + escapeHtml('检测失败: ' + err);
    }
    var listEl = $('modal-sources-list');
    if (listEl) {
      var cur = listEl.innerHTML;
      if (!cur || cur.indexOf('正在检测') === 0) listEl.innerHTML = '';
    }
  }
  // 渲染平台状态网格到指定容器（用于 modal）
  function renderPlatformGridToModal(platforms, container) {
    if (!container) return;
    if (!platforms || platforms.length === 0) {
      container.innerHTML = '<div class="pf-empty">暂无检测数据</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      var status = p.status || 'unreachable';
      var statusText = PF_STATUS_TEXT[status] || status;
      var reasonText = (status === 'fail' || status === 'unreachable') && p.reason ? p.reason : '';
      var latencyHtml = (p.latencyMs !== undefined) ? '<div class="pf-latency">' + p.latencyMs + 'ms</div>' : '';
      html += '<div class="pf-item ' + status + '" title="' + escapeHtml(reasonText || statusText) + '">';
      html += '<span class="pf-dot ' + status + '"></span>';
      html += '<div class="pf-info">';
      html += '<div class="pf-name">' + escapeHtml(p.name) + '</div>';
      html += '<div class="pf-status">' + escapeHtml(reasonText || statusText) + '</div>';
      html += latencyHtml;
      html += '</div></div>';
    }
    container.innerHTML = html;
  }
  // ==================== 初始化 ====================
  loadConfig();
  loadPlatforms();
  loadSources();
  // 初始化音源检测 modal
  document.addEventListener('DOMContentLoaded', function () {
    var modal = $('source-test-modal');
    if (modal) {
      var closeBtn = modal.querySelector('.modal-header .close');
      if (closeBtn) {
        closeBtn.addEventListener('click', function () {
          modal.style.display = 'none';
        });
      }
      // 点击背景关闭
      modal.addEventListener('click', function (e) {
        if (e.target === modal) {
          modal.style.display = 'none';
        }
      });
    }
  });
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
