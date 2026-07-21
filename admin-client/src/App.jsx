import React, { useState, useEffect, useRef } from 'react';
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react';
import { 
  Activity, Heart, Database, QrCode, BarChart3, Store, Settings, 
  RefreshCw, LogOut, CheckCircle, AlertTriangle, X, Download, Copy, Printer, 
  Eye, Trash2, Edit3, ShieldAlert, Key, Globe, Plus, ShieldCheck, RefreshCcw
} from 'lucide-react';
import './App.css';

const DEFAULT_ADMIN_KEY = 'Lucky@000';

function App() {
  // Auth & Routing
  const [apiKey, setApiKey] = useState(localStorage.getItem('scanqr_admin_key') || '');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loginInput, setLoginInput] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [activeTab, setActiveTab] = useState('status');

  // Global Lists / States
  const [businesses, setBusinesses] = useState([]);
  const [statusData, setStatusData] = useState({ sites: [], backend: { uptimeSeconds: 0 }, tursoConnected: false });
  const [healthData, setHealthData] = useState(null);
  const [healthPing, setHealthPing] = useState(null);
  const [bankData, setBankData] = useState({ items: [], summary: [], page: 1, totalPages: 1, total: 0 });
  const [analyticsData, setAnalyticsData] = useState({ totalScans: 0, uniqueVisitors: 0, deviceStats: { Smartphone: 0, Desktop: 0 }, logs: [] });
  const [settingsData, setSettingsData] = useState({ geminiApiKey: '', adminApiKey: '' });
  
  // Filtering & Pagination
  const [bankPage, setBankPage] = useState(1);
  const [bankFilter, setBankFilter] = useState('');
  const [bankSearch, setBankSearch] = useState('');
  const [analyticsFilter, setAnalyticsFilter] = useState('ALL');

  // Auto Refresh timers
  const [autoRefresh, setAutoRefresh] = useState(false);
  
  // UI Controls & Loaders
  const [isLoading, setIsLoading] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const [toastType, setToastType] = useState('success');
  const toastTimer = useRef(null);

  // Forms / Modals
  const [isAddFormOpen, setIsAddFormOpen] = useState(false);
  const [newBiz, setNewBiz] = useState({ slug: '', name: '', type: 'mandi restaurant', customType: '', language: 'English', menuItems: '', highlights: '', googleReviewLink: '', geminiApiKey: '' });
  const [editBiz, setEditBiz] = useState(null);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [printBizInfo, setPrintBizInfo] = useState({ title: '', targetUrl: '', emoji: '⚡' });

  // QR Studio Customizer State
  const [qrMode, setQrMode] = useState('registered'); // 'registered' | 'custom'
  const [qrSelectedSlug, setQrSelectedSlug] = useState('');
  const [qrCustomUrl, setQrCustomUrl] = useState('https://scanqr-beta.vercel.app');
  const [qrDarkColor, setQrDarkColor] = useState('#6366f1');
  const [qrLightColor, setQrLightColor] = useState('#ffffff');
  const [qrFrameColor, setQrFrameColor] = useState('#6366f1');
  const [qrSize, setQrSize] = useState(220);
  const [qrCorrectLevel, setQrCorrectLevel] = useState('M');
  const [qrCornerStyle, setQrCornerStyle] = useState('rounded');
  const [qrLabelText, setQrLabelText] = useState('');
  const [qrShowFrame, setQrShowFrame] = useState(true);
  const [uploadedLogo, setUploadedLogo] = useState(null);
  const [qrLogoSize, setQrLogoSize] = useState(22);
  const [qrBizName, setQrBizName] = useState('');
  const [qrBizNameColor, setQrBizNameColor] = useState('#ffffff');
  const [qrBizNamePos, setQrBizNamePos] = useState('bottom');

  const canvasRef = useRef(null);

  // Show Toast Toast Notification helper
  const triggerToast = (msg, type = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastMessage(msg);
    setToastType(type);
    toastTimer.current = setTimeout(() => {
      setToastMessage(null);
    }, 3500);
  };

  // Helper fetch wrapper
  const apiCall = async (path, method = 'GET', body = null) => {
    const key = apiKey || loginInput || DEFAULT_ADMIN_KEY;
    const url = window.location.origin + path;
    const res = await fetch(url, {
      method,
      headers: {
        'x-api-key': key,
        'Content-Type': 'application/json'
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!res.ok) {
      throw new Error(`API error ${res.status}`);
    }
    return res.json();
  };

  // Verify auth on mount
  useEffect(() => {
    if (apiKey) {
      checkLogin(apiKey);
    }
  }, []);

  const checkLogin = async (key) => {
    try {
      setIsLoading(true);
      await fetch(window.location.origin + '/admin/api/businesses', {
        headers: { 'x-api-key': key }
      }).then(r => {
        if (r.ok) {
          setIsLoggedIn(true);
          setApiKey(key);
          localStorage.setItem('scanqr_admin_key', key);
          loadTabContent(activeTab);
        } else {
          localStorage.removeItem('scanqr_admin_key');
          setApiKey('');
          setLoginError(true);
        }
      });
    } catch {
      setLoginError(true);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = (e) => {
    e.preventDefault();
    if (!loginInput.trim()) return;
    checkLogin(loginInput.trim());
  };

  const handleLogout = () => {
    localStorage.removeItem('scanqr_admin_key');
    setApiKey('');
    setIsLoggedIn(false);
    setLoginInput('');
    window.location.reload();
  };

  // Main loader router
  const loadTabContent = (tab) => {
    if (!isLoggedIn) return;
    if (tab === 'status') fetchStatus();
    if (tab === 'health') fetchHealth();
    if (tab === 'bank') fetchBank(bankPage, bankFilter, bankSearch);
    if (tab === 'qrstudio') fetchQrStudio();
    if (tab === 'analytics') fetchAnalytics();
    if (tab === 'businesses') fetchBusinesses();
    if (tab === 'settings') fetchSettings();
  };

  useEffect(() => {
    if (isLoggedIn) {
      loadTabContent(activeTab);
    }
  }, [activeTab, isLoggedIn]);

  // Auto-refresh loops
  useEffect(() => {
    let timer = null;
    if (isLoggedIn && autoRefresh) {
      timer = setInterval(() => {
        if (activeTab === 'status') fetchStatus();
        else if (activeTab === 'bank') fetchBank(bankPage, bankFilter, bankSearch);
        else if (activeTab === 'analytics') fetchAnalytics();
      }, 10000);
    }
    return () => clearInterval(timer);
  }, [isLoggedIn, autoRefresh, activeTab, bankPage, bankFilter, bankSearch]);

  // Health auto refresh loop
  useEffect(() => {
    let timer = null;
    if (isLoggedIn && activeTab === 'health') {
      timer = setInterval(fetchHealth, 15000);
    }
    return () => clearInterval(timer);
  }, [isLoggedIn, activeTab]);

  // 📡 FETCHING FUNCTIONS
  const fetchStatus = async () => {
    try {
      setIsLoading(true);
      const data = await apiCall('/admin/api/status');
      setStatusData(data);
    } catch {
      triggerToast('Failed to load system status', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchHealth = async () => {
    const t0 = performance.now();
    try {
      const data = await apiCall('/health');
      setHealthData(data);
      setHealthPing(Math.round(performance.now() - t0));
    } catch {
      setHealthData({ status: 'error', tursoConnected: false, memory: null });
    }
  };

  const fetchBank = async (page = 1, slugFilter = '', query = '') => {
    try {
      setIsLoading(true);
      const data = await apiCall(`/admin/api/bank/inspect?slug=${encodeURIComponent(slugFilter)}&q=${encodeURIComponent(query)}&page=${page}`);
      setBankData(data);
    } catch {
      triggerToast('Failed to load review bank', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchQrStudio = async () => {
    try {
      const list = await apiCall('/admin/api/businesses');
      setBusinesses(list);
      if (list.length && !qrSelectedSlug) {
        setQrSelectedSlug(list[0].slug);
      }
    } catch {}
  };

  const fetchAnalytics = async () => {
    try {
      setIsLoading(true);
      const data = await apiCall('/admin/api/analytics');
      setAnalyticsData(data);
    } catch {
      triggerToast('Failed to load analytics', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchBusinesses = async () => {
    try {
      setIsLoading(true);
      const list = await apiCall('/admin/api/businesses');
      setBusinesses(list);
    } catch {
      triggerToast('Failed to load businesses list', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const data = await apiCall('/admin/api/settings');
      setSettingsData({ geminiApiKey: data.geminiApiKey || '', adminApiKey: '' });
    } catch {}
  };

  // ⚡ HANDLERS & MUTATIONS
  const handleSaveSettings = async (e) => {
    e.preventDefault();
    try {
      await apiCall('/admin/api/settings', 'POST', {
        geminiApiKey: settingsData.geminiApiKey.trim() || undefined,
        adminApiKey: settingsData.adminApiKey.trim() || undefined
      });
      triggerToast('Global settings saved successfully!', 'success');
      if (settingsData.adminApiKey.trim()) {
        const newKey = settingsData.adminApiKey.trim();
        setApiKey(newKey);
        localStorage.setItem('scanqr_admin_key', newKey);
      }
    } catch {
      triggerToast('Failed to save settings', 'error');
    }
  };

  const handleRegenerateBank = async (slug) => {
    try {
      triggerToast(`Rebuilding 5,000 review bank for ${slug}...`, 'success');
      await apiCall(`/admin/api/bank/generate/${slug}`, 'POST');
      triggerToast(`Success! 5,000 reviews seeded for ${slug}`, 'success');
      if (activeTab === 'bank') fetchBank(bankPage, bankFilter, bankSearch);
      else if (activeTab === 'businesses') fetchBusinesses();
    } catch {
      triggerToast('Failed to generate review bank', 'error');
    }
  };

  const handlePopulateAllBanks = async () => {
    try {
      triggerToast('Generating 15,000 reviews across all businesses into Turso Cloud. Please wait ~15s.', 'success');
      const data = await apiCall('/admin/api/bank/generate-all', 'POST');
      triggerToast(`Success! populated ${data.totalReviews} reviews!`, 'success');
      if (activeTab === 'bank') fetchBank(1, bankFilter, bankSearch);
    } catch {
      triggerToast('Failed to generate all reviews', 'error');
    }
  };

  const handleDeleteBusiness = async (slug) => {
    if (!window.confirm(`Are you sure you want to delete business "${slug}"?`)) return;
    try {
      await apiCall(`/admin/api/config/${slug}`, 'DELETE');
      triggerToast(`Business ${slug} deleted.`, 'success');
      fetchBusinesses();
    } catch {
      triggerToast('Failed to delete business', 'error');
    }
  };

  const handleAddBusiness = async (e) => {
    e.preventDefault();
    const finalSlug = newBiz.slug.trim().toLowerCase().replace(/\s+/g, '_');
    if (!finalSlug) { triggerToast('Slug is required', 'error'); return; }

    const finalType = newBiz.type === 'custom' ? newBiz.customType.trim() || 'store' : newBiz.type;
    const body = {
      name: (newBiz.name || '').trim() || finalSlug,
      type: finalType,
      language: newBiz.language,
      menuItems: newBiz.menuItems ? newBiz.menuItems.trim() : undefined,
      highlights: newBiz.highlights ? newBiz.highlights.trim() : undefined,
      googleReviewLink: (newBiz.googleReviewLink || '').trim(),
      geminiApiKey: newBiz.geminiApiKey ? newBiz.geminiApiKey.trim() : undefined,
      siteUrl: `https://scanqr-beta.vercel.app?biz=${finalSlug}`
    };

    try {
      await apiCall(`/admin/api/config/${finalSlug}`, 'POST', body);
      triggerToast(`Business "${body.name}" added successfully!`, 'success');
      setIsAddFormOpen(false);
      setNewBiz({ slug: '', name: '', type: 'mandi restaurant', customType: '', language: 'English', menuItems: '', highlights: '', googleReviewLink: '', geminiApiKey: '' });
      fetchBusinesses();
    } catch {
      triggerToast('Failed to add business', 'error');
    }
  };

  const handleSaveEditBusiness = async (e) => {
    e.preventDefault();
    const finalType = editBiz.type === 'custom' ? editBiz.customType.trim() || 'store' : editBiz.type;
    const body = {
      name: (editBiz.name || '').trim() || editBiz.slug,
      type: finalType,
      language: editBiz.language,
      menuItems: editBiz.menuItems ? editBiz.menuItems.trim() : undefined,
      highlights: editBiz.highlights ? editBiz.highlights.trim() : undefined,
      googleReviewLink: (editBiz.googleReviewLink || '').trim(),
      geminiApiKey: editBiz.geminiApiKey ? editBiz.geminiApiKey.trim() : undefined,
      siteUrl: `https://scanqr-beta.vercel.app?biz=${editBiz.slug}`
    };

    try {
      await apiCall(`/admin/api/config/${editBiz.slug}`, 'POST', body);
      triggerToast(`Business "${body.name}" updated successfully!`, 'success');
      setEditBiz(null);
      fetchBusinesses();
    } catch {
      triggerToast('Failed to update business', 'error');
    }
  };

  // EMOJI MAPPER FOR PRINT MODAL
  const getEmojiForType = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('mandi')) return '🍗';
    if (t.includes('restaurant') || t.includes('food') || t.includes('dining')) return '🍽️';
    if (t.includes('cafe') || t.includes('coffee') || t.includes('bakery')) return '☕';
    if (t.includes('saloon') || t.includes('barber') || t.includes('haircare')) return '💈';
    if (t.includes('salon') || t.includes('hair') || t.includes('beauty')) return '💇‍♀️';
    if (t.includes('spa') || t.includes('massage')) return '🧖‍♀️';
    if (t.includes('clothing') || t.includes('fashion') || t.includes('wear') || t.includes('boutique')) return '👗';
    if (t.includes('gym') || t.includes('fitness')) return '💪';
    return '⚡';
  };

  const openPrintStand = () => {
    let targetUrl = '';
    let title = 'ScanQR Review';
    let emoji = '⚡';
    if (qrMode === 'registered') {
      const slug = qrSelectedSlug || 'demo';
      targetUrl = `https://scanqr-beta.vercel.app?biz=${slug}`;
      const biz = businesses.find(b => b.slug === slug);
      if (biz) {
        title = biz.name || slug.toUpperCase().replace(/_/g, ' ');
        emoji = getEmojiForType(biz.type);
      } else {
        title = slug.toUpperCase().replace(/_/g, ' ');
      }
    } else {
      targetUrl = qrCustomUrl.trim();
      title = 'Custom Target Review';
    }

    setPrintBizInfo({ title, targetUrl, emoji });
    setIsPrintModalOpen(true);
  };

  // QR LOGO UPLOADER
  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setUploadedLogo(event.target.result);
      setQrCorrectLevel('H'); // Auto force high error correction
    };
    reader.readAsDataURL(file);
  };

  // QR DOWNLOAD PNG
  const downloadPng = () => {
    const qrCanvas = document.getElementById('qr-canvas-hidden');
    if (!qrCanvas) {
      triggerToast('QR code generation is not complete', 'error');
      return;
    }

    const size = qrCanvas.width;
    const pad = 32;
    const nameH = qrBizName.trim() ? 42 : 0;
    const labelH = qrLabelText.trim() ? 44 : 0;
    const totalW = size + pad * 2;
    const totalH = size + pad * 2 + nameH + labelH;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = totalW;
    outCanvas.height = totalH;
    const ctx = outCanvas.getContext('2d');

    // Draw frame color
    ctx.fillStyle = qrShowFrame ? qrFrameColor : '#ffffff';
    ctx.fillRect(0, 0, totalW, totalH);

    // Business Name Top
    let qrOffsetY = pad;
    if (qrBizName.trim() && qrBizNamePos === 'top') {
      ctx.fillStyle = qrBizNameColor;
      ctx.font = 'bold 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(qrBizName.trim(), totalW / 2, pad + 20);
      qrOffsetY = pad + nameH;
    }

    // Inner White Box for QR
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(pad - 8, qrOffsetY - 8, size + 16, size + 16, 12);
    ctx.fill();

    // Draw the QR Canvas
    ctx.drawImage(qrCanvas, pad, qrOffsetY);

    const finishDownload = () => {
      // Business Name Bottom
      if (qrBizName.trim() && qrBizNamePos === 'bottom') {
        ctx.fillStyle = qrBizNameColor;
        ctx.font = 'bold 18px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(qrBizName.trim(), totalW / 2, qrOffsetY + size + pad - 6);
      }
      // Label below inner frame
      if (qrLabelText.trim()) {
        ctx.fillStyle = qrShowFrame ? '#ffffff' : qrDarkColor;
        ctx.font = 'bold 15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(qrLabelText.trim(), totalW / 2, totalH - 14);
      }

      // Trigger actual download link
      const link = document.createElement('a');
      const finalSlug = qrMode === 'registered' ? qrSelectedSlug : 'custom_qr';
      link.download = `ScanQR_${finalSlug}.png`;
      link.href = outCanvas.toDataURL('image/png');
      link.click();
      triggerToast('QR code PNG downloaded successfully!', 'success');
    };

    // Draw central logo overlay if present
    if (uploadedLogo) {
      const img = new Image();
      img.onload = () => {
        const logoW = size * (qrLogoSize / 100);
        const logoH = logoW;
        const logoX = pad + (size - logoW) / 2;
        const logoY = qrOffsetY + (size - logoH) / 2;
        const logoPad = logoW * 0.18;

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.roundRect(logoX - logoPad, logoY - logoPad, logoW + logoPad * 2, logoH + logoPad * 2, 10);
        ctx.fill();
        ctx.drawImage(img, logoX, logoY, logoW, logoH);
        finishDownload();
      };
      img.src = uploadedLogo;
    } else {
      finishDownload();
    }
  };

  // QR DOWNLOAD SVG
  const downloadSvg = () => {
    const targetUrl = qrMode === 'registered' 
      ? `https://scanqr-beta.vercel.app?biz=${qrSelectedSlug}`
      : qrCustomUrl;
    
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 ${qrLabelText ? 330 : 300}" width="300" height="${qrLabelText ? 330 : 300}">
  <rect width="300" height="300" rx="18" fill="${qrShowFrame ? qrFrameColor : '#ffffff'}"/>
  <rect x="14" y="14" width="272" height="272" rx="10" fill="#ffffff"/>
  <text x="150" y="158" font-family="monospace" font-size="11" text-anchor="middle" fill="${qrDarkColor}">QR → ${targetUrl.substring(0, 35)}...</text>
  <text x="150" y="175" font-family="monospace" font-size="9" text-anchor="middle" fill="#888">Download PNG for full QR designer features</text>
  ${qrLabelText ? `<text x="150" y="320" font-family="system-ui" font-size="15" font-weight="bold" text-anchor="middle" fill="${qrShowFrame ? qrFrameColor : qrDarkColor}">${qrLabelText}</text>` : ''}
</svg>`;
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const link = document.createElement('a');
    const finalSlug = qrMode === 'registered' ? qrSelectedSlug : 'custom_qr';
    link.download = `ScanQR_${finalSlug}.svg`;
    link.href = URL.createObjectURL(blob);
    link.click();
    triggerToast('SVG preview generated & downloaded!', 'success');
  };

  // BACKEND REDIRECTION / EXPORTS
  const handleExportCsv = () => {
    window.open(`${window.location.origin}/admin/api/bank/export-csv?key=${encodeURIComponent(apiKey)}`, '_blank');
    triggerToast('Downloading all reviews in CSV format...', 'success');
  };

  const handleExportAnalytics = () => {
    window.open(`${window.location.origin}/admin/api/analytics/export?key=${encodeURIComponent(apiKey)}`, '_blank');
    triggerToast('Downloading analytics log CSV...', 'success');
  };

  const handleClearAnalytics = async () => {
    if (!window.confirm('Are you sure you want to clear scan logs history?')) return;
    try {
      await apiCall('/admin/api/analytics/clear', 'DELETE');
      triggerToast('Analytics logs successfully cleared!', 'success');
      fetchAnalytics();
    } catch {
      triggerToast('Failed to clear analytics', 'error');
    }
  };

  const handleBackupDb = () => {
    window.open(`${window.location.origin}/admin/api/db/export?key=${encodeURIComponent(apiKey)}`, '_blank');
    triggerToast('Downloading Database backup file...', 'success');
  };

  const handleImportDb = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = JSON.parse(event.target.result);
        await apiCall('/admin/api/db/import', 'POST', json);
        triggerToast(`Database restored successfully! ${Object.keys(json).length} Businesses active.`, 'success');
        if (activeTab === 'businesses') fetchBusinesses();
      } catch (err) {
        triggerToast(`Failed to restore database: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
  };

  // RENDER APP
  if (!isLoggedIn) {
    return (
      <div id="loginScreen">
        <form className="login-card" onSubmit={handleLogin}>
          <div className="login-logo">⚡</div>
          <h1>ScanQR Enterprise</h1>
          <p>Turso Cloud Review Engine & QR Customizer</p>
          <div style={{ marginBottom: '20px' }}>
            <input 
              type="password" 
              placeholder="Enter Admin API Key / Password" 
              value={loginInput}
              onChange={(e) => setLoginInput(e.target.value)}
              autoFocus
            />
            {loginError && <div style={{ color: 'var(--danger)', fontSize: '0.82rem', marginTop: '8px', fontWeight: '600' }}>⚠️ Access Denied: Invalid Key</div>}
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={isLoading}>
            {isLoading ? 'Checking Authorization...' : 'Authenticate & Unlock'}
          </button>
        </form>
      </div>
    );
  }

  // Active target redirection URL computation
  const activeQrTargetUrl = qrMode === 'registered'
    ? `https://scanqr-beta.vercel.app?biz=${qrSelectedSlug || 'demo'}`
    : qrCustomUrl;

  return (
    <div id="app" style={{ display: 'block' }}>
      {/* Toast */}
      <div id="toast" className={`${toastMessage ? 'show' : ''} ${toastType}`}>
        {toastMessage}
      </div>

      {/* TOPBAR */}
      <div className="topbar">
        <div className="brand">
          <div className="brand-icon">⚡</div>
          ScanQR React Enterprise
        </div>
        <label className="auto-refresh-toggle">
          <input 
            type="checkbox" 
            checked={autoRefresh} 
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          ⏱️ Auto-Refresh (10s)
        </label>
        <div className="spacer"></div>
        <span className="backend-badge">
          <span className="pulse-dot"></span>
          ☁️ Turso Cloud
        </span>
        <button className="btn btn-ghost btn-sm" onClick={handleLogout}>
          <LogOut size={14} /> Logout
        </button>
      </div>

      {/* NAVIGATION TABS */}
      <div className="tabs-nav">
        <div className={`tab-item ${activeTab === 'status' ? 'active' : ''}`} onClick={() => setActiveTab('status')}>
          <Activity size={16} /> Status
        </div>
        <div className={`tab-item ${activeTab === 'health' ? 'active' : ''}`} onClick={() => setActiveTab('health')}>
          <Heart size={16} /> Health
        </div>
        <div className={`tab-item ${activeTab === 'bank' ? 'active' : ''}`} onClick={() => setActiveTab('bank')}>
          <Database size={16} /> Review Bank
        </div>
        <div className={`tab-item ${activeTab === 'qrstudio' ? 'active' : ''}`} onClick={() => setActiveTab('qrstudio')}>
          <QrCode size={16} /> QR Studio
        </div>
        <div className={`tab-item ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
          <BarChart3 size={16} /> Analytics
        </div>
        <div className={`tab-item ${activeTab === 'businesses' ? 'active' : ''}`} onClick={() => setActiveTab('businesses')}>
          <Store size={16} /> Businesses
        </div>
        <div className={`tab-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
          <Settings size={16} /> Settings
        </div>
      </div>

      {/* CONTENT AREA */}
      <div className="content-area">

        {/* ── 1. STATUS TAB ── */}
        {activeTab === 'status' && (
          <div>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Backend Status</div>
                <div className="stat-value up">Online</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Uptime</div>
                <div className="stat-value accent">
                  {statusData.backend?.uptimeSeconds 
                    ? `${Math.floor(statusData.backend.uptimeSeconds / 3600)}h ${Math.floor((statusData.backend.uptimeSeconds % 3600) / 60)}m`
                    : '—'}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Active Businesses</div>
                <div className="stat-value up">{statusData.sites?.length || 0} Active</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Turso Cloud DB</div>
                <div className={`stat-value ${statusData.tursoConnected ? 'up' : 'danger'}`}>
                  {statusData.tursoConnected ? 'Active' : 'Offline'}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3>Registered Nodes & Health Status</h3>
                <button className="btn btn-ghost btn-sm" onClick={fetchStatus}>
                  <RefreshCw size={14} /> Refresh Status
                </button>
              </div>
              
              {isLoading ? (
                <div style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>Checking registered sites…</div>
              ) : (
                <div className="table-responsive">
                  <table className="status-table">
                    <thead>
                      <tr>
                        <th>Business Name</th>
                        <th>Slug</th>
                        <th>Live Vercel Link</th>
                        <th>Status</th>
                        <th>Latency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statusData.sites?.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>
                            No businesses registered yet.
                          </td>
                        </tr>
                      ) : (
                        statusData.sites?.map((s) => (
                          <tr key={s.slug}>
                            <td><strong>{s.name || s.slug}</strong></td>
                            <td><code style={{ fontSize: '0.82rem', color: 'var(--primary)' }}>{s.slug}</code></td>
                            <td>
                              {s.url ? (
                                <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-cyan)', textDecoration: 'none' }}>
                                  {s.url}
                                </a>
                              ) : (
                                <span style={{ color: 'var(--muted)' }}>—</span>
                              )}
                            </td>
                            <td>
                              <span className={`badge ${s.status === 'up' ? 'badge-up' : 'badge-down'}`}>
                                {s.status === 'up' && <span className="pulse-dot"></span>}
                                {s.status === 'up' ? 'Online' : 'Down'}
                              </span>
                            </td>
                            <td>{s.latencyMs != null ? `${s.latencyMs}ms` : '—'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 2. HEALTH MONITOR TAB ── */}
        {activeTab === 'health' && (
          <div>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">⚙️ Server Status</div>
                <div className="stat-value" style={{ color: healthData?.status === 'ok' ? 'var(--success)' : 'var(--danger)', fontSize: '1.5rem' }}>
                  {healthData?.status === 'ok' ? '✅ Online' : '❌ Error'}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">🗄️ Turso Cloud DB</div>
                <div className="stat-value" style={{ color: healthData?.tursoConnected ? 'var(--success)' : 'var(--danger)', fontSize: '1.5rem' }}>
                  {healthData?.tursoConnected ? '✅ Connected' : '❌ Disconnected'}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">⏱️ Server Uptime</div>
                <div className="stat-value accent" style={{ fontSize: '1.4rem' }}>
                  {healthData?.uptimeFormatted || '—'}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">📡 API Ping Latency</div>
                <div className="stat-value" style={{ color: healthPing < 200 ? 'var(--success)' : healthPing < 600 ? 'var(--warning)' : 'var(--danger)', fontSize: '1.5rem' }}>
                  {healthPing ?? '—'} ms
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">🧠 Heap Usage</div>
                <div className="stat-value" style={{ fontSize: '1.5rem' }}>
                  {healthData?.memory ? Math.round((healthData.memory.heapUsedMB / healthData.memory.heapTotalMB) * 100) : 0}%
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '4px' }}>
                  {healthData?.memory?.heapUsedMB} / {healthData?.memory?.heapTotalMB} MB
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">🏪 Businesses</div>
                <div className="stat-value accent" style={{ fontSize: '1.5rem' }}>
                  {healthData?.registeredBusinesses ?? '—'}
                </div>
              </div>
            </div>

            {/* Memory details */}
            <div className="card" style={{ marginBottom: '22px' }}>
              <div className="card-header">
                <h3>🧠 Memory Usage Details</h3>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                    Last refreshed: {new Date().toLocaleTimeString()} · Ping: {healthPing}ms
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={fetchHealth}>
                    <RefreshCcw size={12} /> Refresh
                  </button>
                </div>
              </div>
              
              {healthData?.memory && (
                <div style={{ display: 'grid', gap: '14px' }}>
                  {[
                    { label: 'Heap Used', val: healthData.memory.heapUsedMB, max: healthData.memory.heapTotalMB, color: 'var(--success)' },
                    { label: 'Heap Total', val: healthData.memory.heapTotalMB, max: healthData.memory.rssMB, color: 'var(--primary)' },
                    { label: 'RSS (Total Process)', val: healthData.memory.rssMB, max: Math.max(healthData.memory.rssMB, 512), color: 'var(--accent-cyan)' },
                    { label: 'External', val: healthData.memory.externalMB, max: 100, color: 'var(--warning)' },
                  ].map((b) => {
                    const pct = Math.min(100, Math.round((b.val / b.max) * 100)) || 0;
                    return (
                      <div key={b.label}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '0.85rem' }}>
                          <span style={{ color: 'var(--muted)' }}>{b.label}</span>
                          <strong>{b.val} MB</strong>
                        </div>
                        <div className="traffic-bar-bg">
                          <div className="traffic-bar-fill" style={{ width: `${pct}%`, background: b.color, borderRadius: '10px' }}></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* FIFO Queue depths */}
            <div className="card" style={{ marginBottom: '22px' }}>
              <div className="card-header">
                <h3>⚡ RAM FIFO Queue Depths</h3>
                <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Target: 10 reviews buffered per business</span>
              </div>
              <div id="healthFifoGrid" className="grid-3col">
                {Object.keys(healthData?.fifoQueueDepths || {}).length === 0 ? (
                  <div style={{ color: 'var(--muted)', fontSize: '0.9rem', padding: '10px', gridColumn: 'span 3' }}>
                    No FIFO queues active yet. Perform a scan to warm up the RAM queue.
                  </div>
                ) : (
                  Object.entries(healthData?.fifoQueueDepths || {}).map(([slug, depth]) => {
                    const pct = Math.min(100, Math.round((depth / 10) * 100));
                    const col = depth >= 8 ? 'var(--success)' : depth >= 4 ? 'var(--warning)' : 'var(--danger)';
                    return (
                      <div key={slug} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px' }}>
                        <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '4px' }}>
                          <code>{slug}</code>
                        </div>
                        <div style={{ fontFamily: '"Outfit",sans-serif', fontSize: '1.8rem', fontWeight: '800', color: col }}>
                          {depth}<span style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--muted)' }}>/10</span>
                        </div>
                        <div className="traffic-bar-bg" style={{ marginTop: '8px' }}>
                          <div className="traffic-bar-fill" style={{ width: `${pct}%`, background: col, borderRadius: '10px' }}></div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* System Info Table */}
            <div className="card">
              <div className="card-header"><h3>🖥️ System Info</h3></div>
              <div className="table-responsive">
                <table className="status-table">
                  <thead>
                    <tr><th>Property</th><th>Value</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>Node.js Version</td>
                      <td><strong>{healthData?.nodeVersion || '—'}</strong></td>
                    </tr>
                    <tr>
                      <td style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>Environment</td>
                      <td><strong>{healthData?.env || '—'}</strong></td>
                    </tr>
                    <tr>
                      <td style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>Platform</td>
                      <td><strong>{healthData?.platform || '—'}</strong></td>
                    </tr>
                    <tr>
                      <td style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>Server Time</td>
                      <td><strong>{healthData?.ts ? new Date(healthData.ts).toLocaleString() : '—'}</strong></td>
                    </tr>
                    <tr>
                      <td style={{ color: 'var(--muted)', fontSize: '0.88rem' }}>Raw Uptime</td>
                      <td><strong>{healthData?.uptime ? `${healthData.uptime} seconds` : '—'}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ── 3. REVIEW BANK TAB ── */}
        {activeTab === 'bank' && (
          <div>
            <div className="tab-header">
              <div>
                <h2 style={{ fontFamily: '"Outfit",sans-serif', fontSize: '1.35rem', fontWeight: 800, marginBottom: '6px' }}>📦 15,000 Pre-Loaded Review Bank Engine (Turso Cloud DB)</h2>
                <div style={{ fontSize: '0.88rem', color: 'var(--muted)' }}>Preloaded 5,000 human-toned reviews per business stored in Turso Cloud DB for &lt; 5ms speed.</div>
              </div>
              <div style={{ display: 'flex', gap: '12px' }} className="flex-gap">
                <button className="btn btn-primary btn-sm" onClick={handleExportCsv}><Download size={14} /> Download 15K Reviews CSV</button>
                <button className="btn btn-success btn-sm" onClick={handlePopulateAllBanks}><Database size={14} /> Populate All 15K Banks</button>
              </div>
            </div>

            {/* Bank Summary Cards */}
            <div className="biz-grid" style={{ marginBottom: '32px' }}>
              {bankData.summary?.map((b) => {
                const fillPct = Math.min(100, Math.round((b.totalInBank / 5000) * 100));
                return (
                  <div key={b.slug} className="biz-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                      <div>
                        <div style={{ fontFamily: '"Outfit",sans-serif', fontWeight: 700, fontSize: '1.05rem' }}>{b.name}</div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>slug: <code>{b.slug}</code></div>
                      </div>
                      <span className="badge badge-up">📦 5,000 Bank</span>
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '4px' }}>
                        <span style={{ color: 'var(--muted)' }}>Bank Load Capacity</span>
                        <span style={{ fontWeight: 600, color: 'var(--success)' }}>{b.totalInBank.toLocaleString()} / 5,000 Reviews</span>
                      </div>
                      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', height: '8px', overflow: 'hidden' }}>
                        <div style={{ width: `${fillPct}%`, background: 'var(--success)', height: '100%' }}></div>
                      </div>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', background: 'var(--bg)', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', marginBottom: '12px', display: 'flex', justifyContent: 'space-between' }}>
                      <span>📍 Current Pointer Index:</span>
                      <strong style={{ color: 'var(--accent-cyan)' }}>#{b.currentPointer}</strong>
                    </div>
                    <button className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={() => handleRegenerateBank(b.slug)}>
                      <RefreshCw size={12} /> Regenerate 5,000 Bank
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Inspector Search Form */}
            <div className="card">
              <div className="card-header">
                <h3>🔍 Line-by-Line 15,000 Review Inspector & Search</h3>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <select 
                    value={bankFilter} 
                    onChange={(e) => { setBankFilter(e.target.value); setBankPage(1); fetchBank(1, e.target.value, bankSearch); }}
                    style={{ width: 'auto', padding: '7px 14px', fontSize: '0.88rem' }}
                  >
                    <option value="">All Businesses</option>
                    {bankData.summary?.map(b => (
                      <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>
                    ))}
                  </select>
                  <input 
                    type="text" 
                    placeholder="Search keywords e.g. mandi, haircut..." 
                    value={bankSearch}
                    onChange={(e) => { setBankSearch(e.target.value); setBankPage(1); fetchBank(1, bankFilter, e.target.value); }}
                    style={{ width: '240px', padding: '7px 14px', fontSize: '0.88rem' }}
                  />
                  <button className="btn btn-ghost btn-sm" onClick={() => fetchBank(bankPage, bankFilter, bankSearch)}>
                    <RefreshCw size={12} /> Refresh
                  </button>
                </div>
              </div>

              <div style={{ fontSize: '0.88rem', color: 'var(--muted)', marginBottom: '16px' }}>
                Showing <strong>{bankData.items?.length || 0}</strong> of <strong>{(bankData.total || 0).toLocaleString()}</strong> reviews in Review Bank · Page <strong>{bankData.page || 1}</strong> of <strong>{bankData.totalPages || 1}</strong>
              </div>

              {isLoading ? (
                <div style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>Searching reviews...</div>
              ) : (
                <div className="table-responsive">
                  <table className="status-table">
                    <thead>
                      <tr>
                        <th style={{ width: '70px' }}>#</th>
                        <th style={{ width: '160px' }}>Business</th>
                        <th>Review Text</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bankData.items?.length === 0 ? (
                        <tr>
                          <td colSpan={3} style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>
                            No matching reviews found in bank.
                          </td>
                        </tr>
                      ) : (
                        bankData.items?.map((item) => (
                          <tr key={item.id}>
                            <td><code style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>#{item.reviewOrder}</code></td>
                            <td>
                              <strong>{item.businessName}</strong>
                              <br />
                              <code style={{ fontSize: '0.75rem', color: 'var(--primary)' }}>{item.slug}</code>
                            </td>
                            <td style={{ lineHeight: '1.5', fontSize: '0.9rem' }}>"{item.review}"</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pagination controls */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
                <button 
                  className="btn btn-ghost btn-sm" 
                  disabled={bankPage <= 1} 
                  onClick={() => { setBankPage(p => p - 1); fetchBank(bankPage - 1, bankFilter, bankSearch); }}
                >
                  ← Previous
                </button>
                <span style={{ fontSize: '0.88rem', color: 'var(--muted)' }}>
                  Page {bankData.page || 1} of {bankData.totalPages || 1}
                </span>
                <button 
                  className="btn btn-ghost btn-sm" 
                  disabled={bankPage >= bankData.totalPages} 
                  onClick={() => { setBankPage(p => p + 1); fetchBank(bankPage + 1, bankFilter, bankSearch); }}
                >
                  Next →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── 4. QR STUDIO TAB ── */}
        {activeTab === 'qrstudio' && (
          <div>
            {/* Info Banner */}
            <div className="info-banner">
              <div style={{ fontSize: '2rem' }}>♾️</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.97rem', marginBottom: '3px' }}>QR Codes Never Expire</div>
                <div style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
                  Your QR codes point to a permanent redirection engine Vercel URL. Updating the target Google Review link in the Businesses tab updates the QR code target instantly without reprinting!
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3>🎨 Live QR Code Designer & Instant Generator Studio</h3>
                <button className="btn btn-success btn-sm" onClick={openPrintStand}>
                  <Printer size={14} /> Print Counter Stand
                </button>
              </div>

              {/* Mode Selection */}
              <div style={{ marginBottom: '20px', display: 'flex', gap: '12px', background: 'var(--bg)', padding: '6px', borderRadius: '12px', border: '1px solid var(--border)', width: 'fit-content' }}>
                <label 
                  style={{ fontSize: '0.88rem', cursor: 'pointer', padding: '8px 16px', borderRadius: '8px', background: qrMode === 'registered' ? 'var(--card)' : 'transparent', color: qrMode === 'registered' ? '#fff' : 'var(--muted)' }}
                  onClick={() => setQrMode('registered')}
                >
                  🏪 Registered Business
                </label>
                <label 
                  style={{ fontSize: '0.88rem', cursor: 'pointer', padding: '8px 16px', borderRadius: '8px', background: qrMode === 'custom' ? 'var(--card)' : 'transparent', color: qrMode === 'custom' ? '#fff' : 'var(--muted)' }}
                  onClick={() => setQrMode('custom')}
                >
                  ⚡ Instant Custom Link
                </label>
              </div>

              <div className="qr-studio-layout">
                {/* Controls (LEFT) */}
                <div style={{ display: 'grid', gap: '18px' }}>
                  {qrMode === 'registered' ? (
                    <div>
                      <label style={{ fontSize: '0.85rem', color: 'var(--muted)', display: 'block', marginBotoom: '6px' }}>Select Registered Business</label>
                      <select value={qrSelectedSlug} onChange={(e) => setQrSelectedSlug(e.target.value)}>
                        {businesses.map((b) => (
                          <option key={b.slug} value={b.slug}>{b.name || b.slug} ({b.slug})</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label style={{ fontSize: '0.85rem', color: 'var(--muted)', display: 'block', marginBotoom: '6px' }}>Custom URL / Link</label>
                      <input 
                        type="url" 
                        value={qrCustomUrl} 
                        onChange={(e) => setQrCustomUrl(e.target.value)} 
                        placeholder="https://..."
                      />
                    </div>
                  )}

                  {/* Colors row */}
                  <div className="grid-3col">
                    <div>
                      <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>🎨 QR Dark Color</label>
                      <input type="color" value={qrDarkColor} onChange={(e) => setQrDarkColor(e.target.value)} style={{ height: '44px', padding: '3px', cursor: 'pointer' }} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>⬜ QR Background</label>
                      <input type="color" value={qrLightColor} onChange={(e) => setQrLightColor(e.target.value)} style={{ height: '44px', padding: '3px', cursor: 'pointer' }} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>🖼️ Frame Color</label>
                      <input type="color" value={qrFrameColor} onChange={(e) => setQrFrameColor(e.target.value)} style={{ height: '44px', padding: '3px', cursor: 'pointer' }} />
                    </div>
                  </div>

                  {/* Size slider */}
                  <div>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>📐 QR Size: <strong>{qrSize}px</strong></label>
                    <input type="range" min={140} max={400} step={20} value={qrSize} onChange={(e) => setQrSize(parseInt(e.target.value))} style={{ width: '100%', accentColor: 'var(--primary)' }} />
                  </div>

                  {/* EC & Corner styles */}
                  <div className="grid-2col">
                    <div>
                      <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>🛡️ Error Correction</label>
                      <select value={qrCorrectLevel} onChange={(e) => setQrCorrectLevel(e.target.value)}>
                        <option value="H">H — Highest (30%)</option>
                        <option value="Q">Q — High (25%)</option>
                        <option value="M">M — Medium (15%)</option>
                        <option value="L">L — Low (7%)</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>🔘 Corner Style</label>
                      <select value={qrCornerStyle} onChange={(e) => setQrCornerStyle(e.target.value)}>
                        <option value="square">■ Square (Classic)</option>
                        <option value="rounded">● Rounded (Modern)</option>
                        <option value="dots">• Dots (Premium)</option>
                      </select>
                    </div>
                  </div>

                  {/* Label below QR */}
                  <div className="grid-2col">
                    <div>
                      <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>🏷️ Label Text (below QR)</label>
                      <input type="text" value={qrLabelText} onChange={(e) => setQrLabelText(e.target.value)} placeholder="e.g. Scan to Rate Us! ⭐" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '4px' }}>
                      <label style={{ fontSize: '0.82rem', color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '7px' }}>
                        <input type="checkbox" checked={qrShowFrame} onChange={(e) => setQrShowFrame(e.target.checked)} style={{ width: '16px', height: '16px', accentColor: 'var(--primary)' }} />
                        🖼️ Show Colored Border Frame
                      </label>
                    </div>
                  </div>

                  {/* Central Logo */}
                  <div style={{ background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: '12px', padding: '14px' }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, marginBottom: '10px' }}>🖼️ Center Logo / Brand Image</div>
                    <div className="grid-2col-logo">
                      <div>
                        <label style={{ fontSize: '0.8rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>Upload Image (PNG/JPG)</label>
                        <input type="file" accept="image/*" onChange={handleLogoUpload} style={{ fontSize: '0.82rem' }} />
                        {uploadedLogo && (
                          <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center' }}>
                            <img src={uploadedLogo} alt="Logo thumbnail" style={{ height: '44px', borderRadius: '8px', border: '1px solid var(--border)', background: '#fff', padding: '4px' }} />
                            <button onClick={() => setUploadedLogo(null)} style={{ marginLeft: '8px', background: 'none', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: '6px', fontSize: '0.75rem', padding: '3px 8px', cursor: 'pointer' }}>✕ Remove</button>
                          </div>
                        )}
                      </div>
                      <div>
                        <label style={{ fontSize: '0.8rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>Logo Size: <strong>{qrLogoSize}%</strong></label>
                        <input type="range" min={10} max={35} value={qrLogoSize} onChange={(e) => setQrLogoSize(parseInt(e.target.value))} style={{ width: '100%', accentColor: 'var(--primary)' }} />
                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '4px' }}>⚠️ Forces High (H) error correction</div>
                      </div>
                    </div>
                  </div>

                  {/* Business Name overlay */}
                  <div style={{ background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: '12px', padding: '14px' }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, marginBottom: '10px' }}>🏪 Business Name on QR Frame</div>
                    <div className="grid-3col-name">
                      <div>
                        <label style={{ fontSize: '0.8rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>Name Text</label>
                        <input type="text" value={qrBizName} onChange={(e) => setQrBizName(e.target.value)} placeholder="e.g. Prison Mandi" />
                      </div>
                      <div>
                        <label style={{ fontSize: '0.8rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>Name Color</label>
                        <input type="color" value={qrBizNameColor} onChange={(e) => setQrBizNameColor(e.target.value)} style={{ height: '38px', padding: '3px', cursor: 'pointer' }} />
                      </div>
                      <div>
                        <label style={{ fontSize: '0.8rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>Position</label>
                        <select value={qrBizNamePos} onChange={(e) => setQrBizNamePos(e.target.value)}>
                          <option value="top">⬆️ Top of Frame</option>
                          <option value="bottom">⬇️ Bottom of Frame</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Redirection target URL */}
                  <div>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '5px' }}>🔗 Active Redirection Target URL</label>
                    <input type="text" readOnly value={activeQrTargetUrl} style={{ opacity: 0.85, fontWeight: 600, color: 'var(--accent-cyan)' }} />
                  </div>
                </div>

                {/* Preview Box (RIGHT) */}
                <div style={{ background: 'var(--card)', border: '1px solid var(--border-light)', borderRadius: '18px', padding: '24px', textAlign: 'center' }}>
                  
                  {/* Live Render Area */}
                  <div style={{ display: 'inline-block', marginBottom: '16px' }}>
                    <div style={{ 
                      display: 'inline-block',
                      padding: qrShowFrame ? (qrBizName && qrBizNamePos === 'top' ? '8px 14px 14px' : '14px 14px 8px') : '14px',
                      background: qrShowFrame ? qrFrameColor : '#ffffff',
                      borderRadius: qrShowFrame ? '20px' : '16px',
                      boxShadow: '0 10px 25px rgba(0, 0, 0, 0.3)',
                      position: 'relative'
                    }}>
                      {qrBizName && qrBizNamePos === 'top' && (
                        <div style={{ fontFamily: 'system-ui, sans-serif', fontWeight: 800, fontSize: '0.95rem', color: qrBizNameColor, textAlign: 'center', padding: '4px 0 8px', letterSpacing: '0.04em' }}>
                          {qrBizName}
                        </div>
                      )}
                      
                      <div style={{ background: '#ffffff', borderRadius: '10px', padding: '8px', display: 'inline-block', position: 'relative' }}>
                        {/* Visible React QR Code */}
                        <QRCodeSVG 
                          value={activeQrTargetUrl}
                          size={qrSize}
                          bgColor={qrLightColor}
                          fgColor={qrDarkColor}
                          level={uploadedLogo ? 'H' : qrCorrectLevel}
                          includeMargin={false}
                          style={{
                            borderRadius: qrCornerStyle === 'rounded' ? '10px' : qrCornerStyle === 'dots' ? '50%' : '0px',
                            transform: qrCornerStyle === 'dots' ? 'scale(0.96)' : 'none'
                          }}
                          imageSettings={uploadedLogo ? {
                            src: uploadedLogo,
                            x: undefined,
                            y: undefined,
                            height: qrSize * (qrLogoSize / 100),
                            width: qrSize * (qrLogoSize / 100),
                            excavate: true
                          } : undefined}
                        />
                        {/* Hidden Canvas QR Code used only for PNG generation */}
                        <div style={{ display: 'none' }}>
                          <QRCodeCanvas 
                            id="qr-canvas-hidden"
                            value={activeQrTargetUrl}
                            size={qrSize}
                            bgColor={qrLightColor}
                            fgColor={qrDarkColor}
                            level={uploadedLogo ? 'H' : qrCorrectLevel}
                          />
                        </div>
                      </div>

                      {qrBizName && qrBizNamePos === 'bottom' && (
                        <div style={{ fontFamily: 'system-ui, sans-serif', fontWeight: 800, fontSize: '0.95rem', color: qrBizNameColor, textAlign: 'center', padding: '8px 0 4px', letterSpacing: '0.04em' }}>
                          {qrBizName}
                        </div>
                      )}
                    </div>
                  </div>

                  {qrLabelText && (
                    <div style={{ fontSize: '0.9rem', fontWeight: 600, color: qrShowFrame ? qrFrameColor : qrDarkColor, marginBottom: '14px', minHeight: '20px' }}>
                      {qrLabelText}
                    </div>
                  )}

                  {/* Actions buttons */}
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button className="btn btn-primary btn-sm" onClick={downloadPng}><Download size={12} /> PNG</button>
                    <button className="btn btn-ghost btn-sm" onClick={downloadSvg}><Globe size={12} /> SVG</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(activeQrTargetUrl); triggerToast('URL Copied!', 'success'); }}>
                      <Copy size={12} /> Copy URL
                    </button>
                  </div>
                  
                  <div style={{ marginTop: '14px', fontSize: '0.75rem', color: 'var(--muted)', background: 'var(--bg)', borderRadius: '8px', padding: '8px' }}>
                    ♾️ Permanent Redirection · Update Target Anytime
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── 5. ANALYTICS TAB ── */}
        {activeTab === 'analytics' && (
          <div>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Total Scans</div>
                <div className="stat-value accent">{analyticsData.totalScans}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Unique Visitors</div>
                <div className="stat-value up">{analyticsData.uniqueVisitors}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Mobile Traffic</div>
                <div className="stat-value accent">
                  {analyticsData.totalScans 
                    ? Math.round(((analyticsData.deviceStats?.Smartphone || 0) / (analyticsData.totalScans || 1)) * 100) 
                    : 0}%
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Scan Log Entries</div>
                <div className="stat-value up">{analyticsData.logs?.length || 0}</div>
              </div>
            </div>

            {/* Split Device Bar */}
            <div className="card" style={{ marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ fontSize: '0.92rem', fontWeight: 600 }}>📱 Traffic Device Split</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                  {analyticsData.deviceStats?.Smartphone || 0} Smartphone vs {analyticsData.deviceStats?.Desktop || 0} Desktop
                </div>
              </div>
              <div className="traffic-bar-bg">
                <div style={{ 
                  width: `${analyticsData.totalScans ? ((analyticsData.deviceStats?.Smartphone || 0) / analyticsData.totalScans) * 100 : 50}%`,
                  background: 'var(--primary)',
                  height: '100%',
                  transition: 'width 300ms ease'
                }}></div>
                <div style={{ 
                  width: `${analyticsData.totalScans ? ((analyticsData.deviceStats?.Desktop || 0) / analyticsData.totalScans) * 100 : 50}%`,
                  background: 'var(--accent-cyan)',
                  height: '100%',
                  transition: 'width 300ms ease'
                }}></div>
              </div>
            </div>

            {/* Table logs */}
            <div className="card">
              <div className="card-header">
                <h3>📊 Real-Time Scan Activity Log</h3>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <select 
                    value={analyticsFilter} 
                    onChange={(e) => setAnalyticsFilter(e.target.value)}
                    style={{ width: 'auto', padding: '7px 14px', fontSize: '0.88rem' }}
                  >
                    <option value="ALL">Filter: All Businesses</option>
                    {businesses.map(b => (
                      <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>
                    ))}
                  </select>
                  <button className="btn btn-ghost btn-sm" onClick={handleExportAnalytics}><Download size={12} /> Export CSV</button>
                  <button className="btn btn-ghost btn-sm" onClick={fetchAnalytics}><RefreshCw size={12} /> Refresh</button>
                  <button className="btn btn-ghost btn-sm" onClick={handleClearAnalytics} style={{ color: 'var(--danger)' }}><Trash2 size={12} /> Clear Logs</button>
                </div>
              </div>

              {isLoading ? (
                <div style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>Loading scan history…</div>
              ) : (
                <div className="table-responsive">
                  <table className="status-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Date</th>
                        <th>Business Slug</th>
                        <th>Device</th>
                        <th>Time of Day</th>
                        <th>Review Engine Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(analyticsFilter === 'ALL' 
                        ? analyticsData.logs 
                        : analyticsData.logs?.filter(l => l.slug === analyticsFilter)
                      )?.length === 0 ? (
                        <tr>
                          <td colSpan={6} style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>
                            No scan activity logged for this filter.
                          </td>
                        </tr>
                      ) : (
                        (analyticsFilter === 'ALL' 
                          ? analyticsData.logs 
                          : analyticsData.logs?.filter(l => l.slug === analyticsFilter)
                        )?.map((l) => (
                          <tr key={l.id}>
                            <td>{l.timestamp}</td>
                            <td>{l.date}</td>
                            <td><code style={{ fontSize: '0.82rem', color: 'var(--primary)' }}>{l.slug}</code></td>
                            <td>{l.deviceType}</td>
                            <td>{l.timeOfDay}</td>
                            <td><span className="badge badge-up">{l.source}</span></td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 6. BUSINESSES TAB ── */}
        {activeTab === 'businesses' && (
          <div>
            <div className="tab-header">
              <h2 style={{ fontFamily: '"Outfit",sans-serif', fontWeight: 800, fontSize: '1.35rem' }}>Registered Businesses (Turso Cloud DB Active)</h2>
              <div style={{ display: 'flex', gap: '12px' }} className="flex-gap">
                <button className="btn btn-ghost btn-sm" onClick={handleBackupDb}><Download size={14} /> Backup DB (JSON)</button>
                <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                  📤 Restore DB (JSON)
                  <input type="file" accept=".json" onChange={handleImportDb} style={{ display: 'none' }} />
                </label>
                <button className="btn btn-success btn-sm" onClick={() => setIsAddFormOpen(!isAddFormOpen)}>
                  <Plus size={14} /> Add New Business
                </button>
              </div>
            </div>

            {/* ADD FORM ACCORDION */}
            {isAddFormOpen && (
              <form className="add-form" onSubmit={handleAddBusiness}>
                <div style={{ fontFamily: '"Outfit",sans-serif', fontWeight: 700, fontSize: '1.1rem', marginBottom: '18px' }}>
                  ➕ Add New Business Settings
                </div>
                <div className="add-form-grid">
                  <div>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Slug (unique ID, e.g. prision_mandi)</label>
                    <input 
                      type="text" 
                      placeholder="e.g. prision_mandi"
                      value={newBiz.slug}
                      onChange={(e) => setNewBiz({ ...newBiz, slug: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Business Name</label>
                    <input 
                      type="text" 
                      placeholder="e.g. Prison Mandi"
                      value={newBiz.name}
                      onChange={(e) => setNewBiz({ ...newBiz, name: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Business Category / Type</label>
                    <select 
                      value={newBiz.type}
                      onChange={(e) => setNewBiz({ ...newBiz, type: e.target.value })}
                    >
                      <option value="mandi restaurant">Mandi Restaurant</option>
                      <option value="clothing store">Clothing Store / Fashion</option>
                      <option value="saloon">Saloon / Hair Care</option>
                      <option value="salon">Beauty Salon</option>
                      <option value="barbershop">Barbershop</option>
                      <option value="spa">Spa & Wellness</option>
                      <option value="restaurant">Restaurant / Dining</option>
                      <option value="cafe">Cafe / Coffee Shop</option>
                      <option value="custom">Custom Category…</option>
                    </select>
                    {newBiz.type === 'custom' && (
                      <input 
                        type="text" 
                        placeholder="Type custom category e.g. Bakery" 
                        value={newBiz.customType}
                        onChange={(e) => setNewBiz({ ...newBiz, customType: e.target.value })}
                        style={{ marginTop: '8px' }}
                      />
                    )}
                  </div>
                  <div>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Target Review Language</label>
                    <select 
                      value={newBiz.language}
                      onChange={(e) => setNewBiz({ ...newBiz, language: e.target.value })}
                    >
                      <option value="English">🇺🇸 English</option>
                      <option value="Spanish">🇪🇸 Spanish</option>
                      <option value="Hindi">🇮🇳 Hindi / Hinglish</option>
                      <option value="French">🇫🇷 French</option>
                      <option value="German">🇩🇪 German</option>
                      <option value="Arabic">🇦🇪 Arabic</option>
                    </select>
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Popular Menu / Services / Products (comma separated)</label>
                    <input 
                      type="text" 
                      placeholder="e.g. haircut, beard trim, hair spa"
                      value={newBiz.menuItems}
                      onChange={(e) => setNewBiz({ ...newBiz, menuItems: e.target.value })}
                    />
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Specialties & Highlights (comma separated)</label>
                    <input 
                      type="text" 
                      placeholder="e.g. spotless clean salon, friendly barbers"
                      value={newBiz.highlights}
                      onChange={(e) => setNewBiz({ ...newBiz, highlights: e.target.value })}
                    />
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Google Review Target Link</label>
                    <input 
                      type="url" 
                      placeholder="https://search.google.com/local/writereview?placeid=..."
                      value={newBiz.googleReviewLink}
                      onChange={(e) => setNewBiz({ ...newBiz, googleReviewLink: e.target.value })}
                      required
                    />
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Custom Gemini API Key (Optional — overrides global key)</label>
                    <input 
                      type="text" 
                      placeholder="AIzaSy... (Leave empty to use global key)"
                      value={newBiz.geminiApiKey}
                      onChange={(e) => setNewBiz({ ...newBiz, geminiApiKey: e.target.value })}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
                  <button type="submit" className="btn btn-primary btn-sm">Save & Populate 5K Review Bank</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setIsAddFormOpen(false)}>Cancel</button>
                </div>
              </form>
            )}

            {/* List business card grid */}
            {isLoading ? (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--muted)' }}>Loading registered businesses…</div>
            ) : (
              <div className="biz-grid">
                {businesses.length === 0 ? (
                  <div style={{ padding: '40px', textAlign: 'center', color: 'var(--muted)', gridColumn: 'span 3' }}>
                    No businesses registered yet. Click "+ Add New Business" to get started.
                  </div>
                ) : (
                  businesses.map((b) => {
                    const siteUrl = b.siteUrl || `https://scanqr-beta.vercel.app?biz=${b.slug}`;
                    return (
                      <div key={b.slug} className="biz-card">
                        <div className="biz-card-header">
                          <div>
                            <div className="biz-name">{b.name || b.slug}</div>
                            <div className="biz-slug">
                              slug: <code>{b.slug}</code> · type: <strong>{b.type || 'store'}</strong>
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'flex-end' }}>
                            <span className={`badge ${b.hasCustomApiKey ? 'badge-up' : 'badge-nourl'}`} style={{ fontSize: '0.75rem' }}>
                              {b.hasCustomApiKey ? '🔑 Custom Key' : '🌐 Global Key'}
                            </span>
                            <span className="badge badge-ai" style={{ fontSize: '0.75rem' }}>
                              🌐 {b.language || 'English'}
                            </span>
                          </div>
                        </div>

                        {b.menuItems && (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-sub)', marginBottom: '4px' }}>
                            🍽️ <strong>Items:</strong> {b.menuItems}
                          </div>
                        )}
                        {b.highlights && (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-sub)', marginBottom: '8px' }}>
                            ⭐ <strong>Highlights:</strong> {b.highlights}
                          </div>
                        )}
                        {b.googleReviewLink && (
                          <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            🔗 {b.googleReviewLink}
                          </div>
                        )}
                        
                        <div style={{ fontSize: '0.82rem', color: 'var(--accent-cyan)', background: 'var(--bg)', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', marginBottom: '14px', wordBreak: 'break-all' }}>
                          Vercel Redirect Link: <a href={siteUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-cyan)', fontWeight: 600, textDecoration: 'none' }}>{siteUrl}</a>
                        </div>

                        <div className="biz-actions">
                          <button className="btn btn-primary btn-sm" onClick={() => handleRegenerateBank(b.slug)}>
                            ⚡ Seed 5K reviews
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditBiz({ ...b, customType: b.type })}>
                            <Edit3 size={12} /> Edit
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(siteUrl); triggerToast('Copied to Clipboard!', 'success'); }}>
                            📋 Copy Link
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDeleteBusiness(b.slug)}>
                            <Trash2 size={12} /> Delete
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {/* ── 7. SETTINGS TAB ── */}
        {activeTab === 'settings' && (
          <div className="card" style={{ maxWidth: '640px', margin: '0 auto' }}>
            <div className="card-header">
              <h3>⚙️ Global System Configuration Settings</h3>
            </div>
            <form onSubmit={handleSaveSettings} style={{ display: 'grid', gap: '18px' }}>
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>
                  🔑 Global Gemini API Key
                </label>
                <input 
                  type="text" 
                  value={settingsData.geminiApiKey} 
                  onChange={(e) => setSettingsData({ ...settingsData, geminiApiKey: e.target.value })}
                  placeholder="AIzaSy..."
                />
                <span style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '4px', display: 'block' }}>
                  Used to generate reviews if a business does not specify its own custom key.
                </span>
              </div>
              
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>
                  🔒 Admin Security Access Key (Password)
                </label>
                <input 
                  type="password" 
                  value={settingsData.adminApiKey} 
                  onChange={(e) => setSettingsData({ ...settingsData, adminApiKey: e.target.value })}
                  placeholder="Type new secure dashboard passcode"
                />
              </div>

              <button type="submit" className="btn btn-primary" style={{ marginTop: '10px' }}>
                Save Settings
              </button>
            </form>
          </div>
        )}
      </div>

      {/* ── EDIT MODAL POPUP ── */}
      {editBiz && (
        <div className="modal-overlay" onClick={() => setEditBiz(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSaveEditBusiness}>
            <h3>✏️ Edit Business Settings</h3>
            <div style={{ display: 'grid', gap: '16px', marginTop: '16px' }}>
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Business Slug</label>
                <input type="text" disabled value={editBiz.slug} style={{ opacity: 0.6 }} />
              </div>
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Business Name</label>
                <input 
                  type="text" 
                  value={editBiz.name} 
                  onChange={(e) => setEditBiz({ ...editBiz, name: e.target.value })}
                  required
                />
              </div>
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Category / Type</label>
                <select 
                  value={editBiz.type} 
                  onChange={(e) => setEditBiz({ ...editBiz, type: e.target.value })}
                >
                  <option value="mandi restaurant">Mandi Restaurant</option>
                  <option value="clothing store">Clothing Store / Fashion</option>
                  <option value="saloon">Saloon / Hair Care</option>
                  <option value="salon">Beauty Salon</option>
                  <option value="barbershop">Barbershop</option>
                  <option value="spa">Spa & Wellness</option>
                  <option value="restaurant">Restaurant / Dining</option>
                  <option value="cafe">Cafe / Coffee Shop</option>
                  <option value="custom">Custom Category…</option>
                </select>
                {editBiz.type === 'custom' && (
                  <input 
                    type="text" 
                    placeholder="Type custom category e.g. Bakery" 
                    value={editBiz.customType}
                    onChange={(e) => setEditBiz({ ...editBiz, customType: e.target.value })}
                    style={{ marginTop: '8px' }}
                  />
                )}
              </div>
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Target Review Language</label>
                <select 
                  value={editBiz.language} 
                  onChange={(e) => setEditBiz({ ...editBiz, language: e.target.value })}
                >
                  <option value="English">🇺🇸 English</option>
                  <option value="Spanish">🇪🇸 Spanish</option>
                  <option value="Hindi">🇮🇳 Hindi / Hinglish</option>
                  <option value="French">🇫🇷 French</option>
                  <option value="German">🇩🇪 German</option>
                  <option value="Arabic">🇦🇪 Arabic</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Popular Menu / Services / Products</label>
                <input 
                  type="text" 
                  value={editBiz.menuItems} 
                  onChange={(e) => setEditBiz({ ...editBiz, menuItems: e.target.value })}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Specialties & Highlights</label>
                <input 
                  type="text" 
                  value={editBiz.highlights} 
                  onChange={(e) => setEditBiz({ ...editBiz, highlights: e.target.value })}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Google Review Target Link</label>
                <input 
                  type="url" 
                  value={editBiz.googleReviewLink} 
                  onChange={(e) => setEditBiz({ ...editBiz, googleReviewLink: e.target.value })}
                  required
                />
              </div>
              <div>
                <label style={{ fontSize: '0.82rem', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>Custom Gemini API Key (Optional)</label>
                <input 
                  type="text" 
                  value={editBiz.geminiApiKey || ''} 
                  onChange={(e) => setEditBiz({ ...editBiz, geminiApiKey: e.target.value })}
                  placeholder="Leave empty to inherit global key"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={() => setEditBiz(null)}>Cancel</button>
              <button type="submit" className="btn btn-success">Save Changes</button>
            </div>
          </form>
        </div>
      )}

      {/* ── PRINT MODAL STAND ── */}
      {isPrintModalOpen && (
        <div className="modal-overlay" onClick={() => setIsPrintModalOpen(false)}>
          <div className="modal" style={{ width: 'min(100% - 32px, 480px)', background: '#fff', color: '#000' }} onClick={(e) => e.stopPropagation()}>
            
            {/* Printable Area */}
            <div id="printableStand" style={{ textAlign: 'center', padding: '24px' }}>
              <div style={{ fontSize: '3rem', marginBottom: '10px' }}>
                {printBizInfo.emoji}
              </div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '8px', fontFamily: '"Outfit",sans-serif' }}>
                {printBizInfo.title}
              </h2>
              <p style={{ fontSize: '0.95rem', color: '#555', marginBottom: '24px' }}>
                Scan to Leave a 5-Star Google Review!
              </p>

              {/* QR Container in Print modal */}
              <div style={{ display: 'inline-block', padding: '18px', border: '2px dashed #ccc', borderRadius: '18px', marginBottom: '20px', background: '#ffffff' }}>
                <QRCodeSVG 
                  value={printBizInfo.targetUrl}
                  size={180}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="H"
                />
              </div>

              <div style={{ fontSize: '0.85rem', color: '#777', fontWeight: 600 }}>
                ⭐ Automatic 5-Star Review Copied & Redirected ⭐
              </div>
            </div>

            {/* Print Modal Footer */}
            <div className="modal-footer" style={{ borderTop: '1px solid #eee', paddingTop: '16px' }}>
              <button className="btn btn-ghost" onClick={() => setIsPrintModalOpen(false)}>Close</button>
              <button className="btn btn-primary" onClick={() => window.print()}>🖨️ Print Stand Now</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
