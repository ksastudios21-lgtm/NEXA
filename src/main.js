import './styles.css';

const ACCOUNT_DATA_VERSION = 'nexa-account-data-v2';
if (localStorage.getItem(ACCOUNT_DATA_VERSION) !== 'ready') {
  ['nexa-users', 'nexa-accounts', 'nexa-active-user', 'nexa-device-trusted', 'nexa-following'].forEach(key => localStorage.removeItem(key));
  localStorage.setItem(ACCOUNT_DATA_VERSION, 'ready');
}

const icons = {
  home: '⌂', feed: '◉', messages: '▱', channels: '◫', studio: '✦', communities: '♧',
  search: '⌕', bell: '♧', settings: '⚙', plus: '+', heart: '♡', comment: '◌', share: '↗',
  bookmark: '▱', play: '▶', send: '➤', mic: '♩', image: '▧', more: '•••', shield: '⬢'
};

const state = {
  authScreen: 'guest',
  authPrompt: '',
  authLoading: false,
  authError: '',
  pendingUser: null,
  users: JSON.parse(localStorage.getItem('nexa-users') || '[]').filter(user => user.email !== 'mohd@nexa.app' && user.username !== 'محمد السالم'),
  accounts: JSON.parse(localStorage.getItem('nexa-accounts') || '[]').filter(user => user.email !== 'mohd@nexa.app' && user.username !== 'محمد السالم'),
  activeUser: JSON.parse(localStorage.getItem('nexa-active-user') || 'null'),
  deviceTrusted: localStorage.getItem('nexa-device-trusted') === 'true',
  active: 'feed',
  liked: new Set(),
  saved: new Set(),
  subscribed: new Set(JSON.parse(localStorage.getItem('nexa-following') || '[]')),
  selectedChat: 0,
  sentMessages: [],
  userVideos: [],
  toast: ''
};

state.devUnlocked = localStorage.getItem('nexa-dev-unlocked') === 'true';
state.devFingerprint = localStorage.getItem('nexa-dev-fingerprint') || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
state.devOwner = localStorage.getItem('nexa-dev-owner') === 'true';
localStorage.setItem('nexa-dev-fingerprint', state.devFingerprint);
state.logoPresses = 0;
state.logoPressTimer = null;

if (state.activeUser?.email === 'mohd@nexa.app' || state.activeUser?.username === 'محمد السالم') {
  state.activeUser = null;
  state.deviceTrusted = false;
  localStorage.removeItem('nexa-active-user');
  localStorage.removeItem('nexa-device-trusted');
}

function persistAuth() {
  localStorage.setItem('nexa-users', JSON.stringify(state.users));
  localStorage.setItem('nexa-accounts', JSON.stringify(state.accounts));
  localStorage.setItem('nexa-active-user', JSON.stringify(state.activeUser));
  localStorage.setItem('nexa-device-trusted', String(state.deviceTrusted));
}

function persistFollowing() {
  localStorage.setItem('nexa-following', JSON.stringify([...state.subscribed]));
}

function currentUser() {
  return state.activeUser || { username: 'مستخدم جديد', email: '', avatar: 'N', color: 'coral', verification: 'standard', followers: 0 };
}

function isAuthenticated() { return Boolean(state.activeUser && state.deviceTrusted); }
function isBoss() { return isAuthenticated() && state.activeUser.role === 'boss'; }
function claimDeveloperBoss() {
  if (state.devUnlocked && state.devOwner) return true;
  const owner = localStorage.getItem('nexa-dev-boss-email');
  if (!owner && isAuthenticated()) {
    localStorage.setItem('nexa-dev-boss-email', state.activeUser.email);
    state.activeUser.role = 'boss';
    state.activeUser.developerStatus = 'approved';
    const user = state.users.find(item => item.email === state.activeUser.email);
    if (user) Object.assign(user, { role: 'boss', developerStatus: 'approved' });
    persistAuth();
    return true;
  }
  return owner === state.activeUser?.email;
}

function hideDeveloperAccess() {
  return !state.devUnlocked;
}

function randomIdentity() {
  const number = Math.floor(100 + Math.random() * 900);
  return { displayName: `NexaUser_${number}`, username: `nx_${number}` };
}

function verificationBadge(user = currentUser()) {
  return user.verification === 'gold' ? '<span class="gold-badge" title="توثيق ذهبي">★</span>' : '';
}

function saveProfileForm(form, firstSetup) {
  const values = new FormData(form);
  const displayName = String(values.get('displayName') || '').trim();
  const username = String(values.get('username') || '').trim();
  const usernameTaken = state.users.some(user => user.username.toLowerCase() === username.toLowerCase() && user.email !== (state.pendingUser?.email || currentUser().email));
  if (!/^[A-Za-z0-9_]+$/.test(username) || usernameTaken) {
    state.authError = usernameTaken ? 'اسم المستخدم مستخدم بالفعل.' : 'استخدم حروفاً إنجليزية وأرقاماً و _ فقط.';
    render();
    return;
  }
  if (displayName.length < 2) { state.authError = 'اكتب اسماً معروضاً صالحاً.'; render(); return; }
  const target = state.pendingUser || state.activeUser;
  Object.assign(target, { displayName, username, bio: String(values.get('bio') || '').trim(), avatar: displayName.slice(0, 1).toUpperCase(), profileSetup: true });
  const index = state.users.findIndex(user => user.email === target.email);
  if (index >= 0) state.users[index] = target;
  state.pendingUser = target;
  state.authError = '';
  persistAuth();
  if (firstSetup) { state.authScreen = 'device'; } else { state.activeUser = target; state.active = 'profile'; }
  render();
}

function discoverableUsers() {
  const currentEmail = currentUser().email;
  return state.users.filter(user => user.email && user.email !== currentEmail);
}

const navItems = [
  ['feed', icons.feed, 'استكشف'], ['messages', icons.messages, 'الرسائل'],
  ['studio', icons.studio, 'إنشاء'], ['spaces', icons.communities, 'المساحات'], ['profile', icons.settings, 'بروفايل']
];

const videos = [];

const chats = [];

const channels = [
  { name: 'NEXA Design', desc: 'أفكار وموارد التصميم الرقمي', members: '38.4K', avatar: 'N', color: 'coral', verified: true },
  { name: 'Future Signals', desc: 'نشرة التقنية والثقافة القادمة', members: '12.8K', avatar: 'F', color: 'blue', verified: true },
  { name: 'رحلات غير مكتملة', desc: 'أماكن، قصص، وطرق جانبية', members: '8.2K', avatar: 'ر', color: 'green', verified: false }
];

function avatar(letter, color, size = '') { return `<span class="avatar ${color} ${size}">${letter}</span>`; }
function nav() { const items = state.devUnlocked && state.devOwner ? [...navItems, ['developers', icons.settings, 'صفحة المطورين']] : navItems; return items.map(([id, icon, label]) => `<button class="nav-item ${state.active === id ? 'active' : ''}" data-nav="${id}" ${id !== 'feed' ? 'data-requires-auth' : ''}><span class="nav-icon">${icon}</span><span>${label}</span>${id === 'messages' ? '<b class="nav-badge">3</b>' : ''}</button>`).join(''); }

function authShell(content) { return `<div class="auth-shell"><div class="auth-art"><div class="auth-orbit orbit-one"></div><div class="auth-orbit orbit-two"></div><span class="auth-n">N</span><div class="auth-art-copy"><span class="eyebrow">NEXA / SOCIAL OS</span><h1>كل عالمك.<br /><em>في مكان واحد.</em></h1><p>فيديوهات، محادثات، مجتمعات وصوتك الخاص.</p></div></div><main class="auth-panel"><div class="auth-brand"><span class="brand-mark">N</span><strong>NEXA</strong></div>${content}<small class="auth-footer">بالاستمرار، أنت توافق على شروط الاستخدام وسياسة الخصوصية.</small></main></div>`; }

function authError() { return state.authError ? `<div class="auth-error">${icons.shield} ${state.authError}</div>` : ''; }

function loginView() { return authShell(`<div class="auth-heading"><span class="eyebrow">${state.authPrompt || 'مرحباً بعودتك'}</span><h2>ادخل إلى عالمك</h2><p>تابع من حيث توقفت، كل شيء بانتظارك.</p></div>${authError()}<form class="auth-form" data-auth="login"><label>البريد الإلكتروني<input name="email" type="email" placeholder="you@example.com" required /></label><label>كلمة المرور<div class="password-field"><input name="password" type="password" placeholder="أدخل كلمة المرور" required minlength="6" /><button type="button" data-toggle-password>إظهار</button></div></label><div class="auth-options"><label class="check-label"><input type="checkbox" checked /> تذكرني</label><button type="button" class="link-btn">نسيت كلمة المرور؟</button></div><button class="auth-submit" type="submit">${state.authLoading ? 'جارٍ التحقق...' : 'تسجيل الدخول'} <span>←</span></button></form><div class="auth-divider"><span>أو</span></div><button class="social-login google-login" type="button" data-local-google>الدخول باستخدام Google <span>G</span></button><button class="social-login" type="button" data-auth-screen="register">ابدأ بإنشاء حسابك <span>✦</span></button><p class="auth-switch">ليس لديك حساب؟ <button data-auth-screen="register">إنشاء حساب جديد</button></p>`); }

function registerView() { return authShell(`<div class="auth-heading"><span class="eyebrow">انضم إلى NEXA</span><h2>أنشئ حسابك</h2><p>سننشئ لك هوية مؤقتة، ثم تختار اسمك بنفسك في الخطوة التالية.</p></div>${authError()}<form class="auth-form" data-auth="register"><label>البريد الإلكتروني<input name="email" type="email" placeholder="you@example.com" required /></label><label>كلمة المرور<div class="password-field"><input name="password" type="password" placeholder="6 أحرف على الأقل" required minlength="6" /><button type="button" data-toggle-password>إظهار</button></div></label><button class="auth-submit" type="submit">${state.authLoading ? 'جارٍ إنشاء الحساب...' : 'إنشاء الحساب'} <span>←</span></button></form><p class="auth-switch">لديك حساب بالفعل؟ <button data-auth-screen="login">تسجيل الدخول</button></p>`); }

function forcedNameView() { const user = state.pendingUser; return authShell(`<div class="auth-heading"><span class="eyebrow">خطوة إلزامية</span><h2>اختر هويتك في NEXA</h2><p>هذه الهوية العشوائية مؤقتة. عدّل الاسم واليوزر قبل دخول التطبيق.</p></div>${authError()}<form class="auth-form" data-profile-setup><label>الاسم المعروض<input name="displayName" value="${user.displayName || ''}" required minlength="2" maxlength="30" /></label><label>اسم المستخدم<input name="username" value="${user.username || ''}" pattern="[A-Za-z0-9_]+" required minlength="3" maxlength="20" /><small class="field-hint">حروف إنجليزية وأرقام و _ فقط</small></label><button class="auth-submit" type="submit">${state.authLoading ? 'جارٍ الحفظ...' : 'حفظ والدخول'} <span>←</span></button></form>`); }

function deviceBindView() { const user = state.pendingUser || currentUser(); return authShell(`<div class="device-icon">${icons.shield}</div><div class="auth-heading centered"><span class="eyebrow">خطوة أمان أخيرة</span><h2>اربط جهازك</h2><p>نحتاج لتوثيق هذا الجهاز حتى يبقى حسابك آمناً.</p></div><div class="device-card"><div class="device-symbol">⌁</div><div><strong>جهاز Linux الحالي</strong><small>تم اكتشافه الآن · موقع تقريبي محلي</small></div><span class="device-check">✓</span></div>${authError()}<button class="auth-submit" data-bind-device>${state.authLoading ? 'جارٍ التحقق...' : 'توثيق هذا الجهاز'} <span>←</span></button><button class="ghost-btn" data-auth-screen="login">إلغاء والعودة</button><small class="device-note">لن نطلب هذا التحقق مجدداً على هذا الجهاز الموثوق.</small>`); }

function shell(content, title, eyebrow = '') {
  const user = currentUser();
  const guest = !isAuthenticated();
    return `<div class="app-shell"><aside class="sidebar"><div class="brand"><button class="brand-mark" data-logo-trigger aria-label="NEXA">N</button><span>NEXA</span></div><div class="profile-mini">${avatar(user.avatar, user.color)}<div><strong>${guest ? 'زائر NEXA' : `${user.displayName || user.username} ${verificationBadge(user)}`}</strong><small>${guest ? 'شاهد بدون حساب' : `@${user.username}`}</small></div><span class="status-dot"></span></div><nav class="primary-nav"><small class="nav-label">${guest ? 'تصفح كزائر' : 'المساحة الشخصية'}</small>${nav()}<small class="nav-label space">استكشف أكثر</small><button class="nav-item"><span class="nav-icon">${icons.search}</span><span>بحث عالمي</span></button><button class="nav-item"><span class="nav-icon">${icons.bookmark}</span><span>المحفوظات</span></button></nav><div class="sidebar-bottom">${guest ? '<button class="guest-login" data-auth-screen="login">تسجيل الدخول <span>←</span></button>' : `<div class="trust"><span>${icons.shield}</span><div><strong>حساب موثوق</strong><small>TrustScore 94%</small></div></div><button class="nav-item" data-add-account><span class="nav-icon">${icons.plus}</span><span>إضافة حساب</span></button><button class="nav-item" data-switch-account><span class="nav-icon">${icons.settings}</span><span>تبديل الحساب</span></button>`}</div></aside><main class="main"><header class="topbar"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1></div><div class="top-actions"><button class="icon-btn" aria-label="الإشعارات">${icons.bell}<i></i></button><button class="create-btn" data-nav="studio"><span>${icons.plus}</span> إنشاء</button>${guest ? '<button class="header-login" data-auth-screen="login">دخول</button>' : `<button class="profile-edit-trigger" data-profile-edit aria-label="تعديل البروفايل">${icons.settings}<span>تعديل البروفايل</span></button>${avatar(user.avatar, user.color)}`}</div></header>${content}</main><aside class="right-rail"><section class="rail-card profile-card"><div class="cover"></div><div class="profile-card-body">${avatar(user.avatar, user.color, 'large')}<button class="edit-btn" data-profile-edit>${guest ? 'إنشاء ملفك' : 'تعديل الملف'}</button><h3>${guest ? 'زائر NEXA' : `${user.displayName || user.username} ${verificationBadge(user)}`}</h3><p>${guest ? 'سجّل لتخصيص تجربتك' : `@${user.username}`}</p><div class="profile-stats"><span><b>${user.followers || 0}</b>متابع</span><span><b>0</b>يتابع</span><span><b>${state.userVideos.length}</b>منشور</span></div></div></section><section class="rail-section trends"><div class="section-heading"><h3>ابدأ رحلتك</h3></div><p>${guest ? 'شاهد الفيديوهات الآن، وسجّل للحفظ والتعليق والنشر.' : 'أنشئ أول فيديو وشاركه مع مجتمع NEXA.'}</p></section></aside></div>`;
}

function feedView() {
  const streamVideos = [...state.userVideos, ...videos];
  const people = discoverableUsers();
  const streamContent = streamVideos.length ? streamVideos.map(videoCard).join('') : `<div class="stream-empty"><span>${icons.studio}</span><h2>لا توجد فيديوهات بعد</h2><p>أنشئ فيديوك الأول ليظهر هنا للمستخدمين.</p><button class="primary-btn" data-nav="studio">افتح الاستوديو <span>←</span></button></div>`;
  return shell(`<div class="feed-layout"><section class="feed-column"><div class="stories-row"><button class="story add-story" data-nav="studio"><span>${icons.plus}</span><small>قصتك</small></button>${['قصتك'].map(x => `<button class="story" data-nav="studio"><span class="story-ring coral">${currentUser().avatar}</span><small>${x}</small></button>`).join('')}</div><div class="feed-tabs"><button class="selected">لك</button><button>يتابعون</button><button>الأحدث</button><span class="feed-filter">⌁</span></div><div class="stream-label"><span class="eyebrow">NEXA STREAM</span><small>${streamVideos.length ? 'اسحب للأعلى للمقطع التالي' : 'ابدأ بالنشر'}</small></div><div class="stream-list">${streamContent}</div></section><aside class="feed-side"><div class="ai-card"><div class="ai-heading"><span class="ai-orb">✦</span><div><small>HyperBrain</small><strong>توصياتك تبدأ منك</strong></div></div><p>ستتغير التوصيات بعد مشاهدة فيديوهات المستخدمين والتفاعل معها.</p><button class="text-btn">إدارة التفضيلات <span>←</span></button></div><div class="suggestions"><div class="section-heading"><h3>أشخاص على NEXA</h3><button>تحديث</button></div>${people.length ? people.map(user => `<div class="suggestion">${avatar(user.avatar, user.color)}<div><strong>${user.username} ${verificationBadge(user)}</strong><small>${user.followers || 0} متابع</small></div><button class="follow-btn ${state.subscribed.has(user.email) ? 'following' : ''}" data-follow-person="${user.email}">${state.subscribed.has(user.email) ? 'تتابعه' : 'متابعة'}</button></div>`).join('') : '<p class="suggestions-empty">لا يوجد أشخاص آخرون بعد.</p>'}</div></aside></div>`, 'مساحتك اليوم', 'الثلاثاء، 22 سبتمبر 2026');
}

function videoCard(video) { const liked = state.liked.has(video.id); const saved = state.saved.has(video.id); const authorIsCurrent = video.authorEmail === currentUser().email; const following = state.subscribed.has(video.authorEmail || video.handle); return `<article class="video-card"><div class="video-visual ${video.color}"><video class="stream-video" data-video="${video.id}" src="${video.src}" muted autoplay loop playsinline preload="auto"></video><div class="visual-grain"></div><div class="video-top"><span class="live-tag">لـك</span><button class="visual-more">${icons.more}</button></div><button class="play-button" data-play="${video.id}" aria-label="تشغيل أو إيقاف الفيديو">${icons.play}</button><div class="video-caption">${avatar(video.avatar, video.color)}<div><strong>${video.author} ${video.authorEmail ? verificationBadge(state.users.find(user => user.email === video.authorEmail)) : ''}</strong><small>${video.handle}</small></div>${authorIsCurrent ? '' : `<button class="follow-pill ${following ? 'following' : ''}" data-follow-person="${video.authorEmail || video.handle}">${following ? 'تتابع' : 'متابعة'}</button>`}<p>${video.title}</p><small>${video.tags}</small></div><div class="video-actions"><button class="action ${liked ? 'active' : ''}" data-like="${video.id}"><span>${liked ? '♥' : icons.heart}</span><small>${liked ? 'أعجبك' : 'إعجاب'}</small></button><button class="action"><span>${icons.comment}</span><small>تعليق</small></button><button class="action"><span>${icons.share}</span><small>مشاركة</small></button><button class="action ${saved ? 'active' : ''}" data-save="${video.id}"><span>${icons.bookmark}</span></button></div></div></article>`; }

function messagesView() { const chat = chats[state.selectedChat]; if (!chat) return shell(`<div class="messages-empty"><span>${icons.messages}</span><h2>لا توجد محادثات بعد</h2><p>ستظهر محادثاتك هنا عندما تتواصل مع مستخدمين حقيقيين.</p><button class="primary-btn" data-nav="feed">استكشف الفيديوهات <span>←</span></button></div>`, 'محادثاتك', 'التواصل'); return shell(`<div class="messages-layout"><section class="chat-list"><div class="list-header"><div><h2>الرسائل</h2><small>تواصل مع دائرتك</small></div><button class="round-add">${icons.plus}</button></div><div class="message-search">${icons.search}<input placeholder="البحث في المحادثات" /></div><div class="chat-tabs"><button class="selected">الكل</button><button>غير مقروءة</button><button>مجموعات</button></div>${chats.map((c, i) => `<button class="chat-row ${i === state.selectedChat ? 'selected' : ''}" data-chat="${i}">${avatar(c.avatar, c.color)}<div class="chat-info"><strong>${c.name}</strong><small>${c.preview}</small></div><div class="chat-meta"><small>${c.time}</small></div></button>`).join('')}</section><section class="chat-window"><header class="chat-header">${avatar(chat.avatar, chat.color)}<div><strong>${chat.name}</strong><small>${chat.online ? 'متصل الآن' : 'آخر ظهور اليوم'}</small></div><div class="chat-tools"><button>${icons.search}</button><button>${icons.more}</button></div></header><div class="chat-messages">${state.sentMessages.map(m => `<div class="message sent">${m}<small>الآن ✓</small></div>`).join('')}</div><form class="composer"><button type="button" class="attach-btn">${icons.plus}</button><input id="message-input" placeholder="اكتب رسالة..." autocomplete="off" /><button type="button" class="emoji-btn">☺</button><button class="send-btn" aria-label="إرسال">${icons.send}</button></form></section></div>`, 'محادثاتك', 'التواصل'); }

function channelsView() { return shell(`<div class="channels-page"><div class="channel-hero"><div><span class="eyebrow">مساحتك الصوتية</span><h2>تابع ما يهمك.<br /><em>بصوتك الخاص.</em></h2><p>قنوات مستقلة، مجتمعات حقيقية، ومحتوى يصل إليك في وقته.</p><button class="primary-btn">اكتشف القنوات <span>←</span></button></div><div class="hero-signal"><div class="signal-line"></div><span>● مباشر الآن</span><strong>142</strong><small>قناة نشطة</small></div></div><div class="page-heading"><div><h2>القنوات المقترحة</h2><p>مختارة بناءً على اهتماماتك</p></div><button class="outline-btn">عرض الكل</button></div><div class="channel-grid">${channels.map(c => `<article class="channel-card"><div class="channel-cover ${c.color}"><span>${c.avatar}</span><small>● ${c.verified ? 'موثق' : 'نشط الآن'}</small></div><div class="channel-body">${avatar(c.avatar, c.color, 'medium')}<h3>${c.name} ${c.verified ? '<span class="verified">✓</span>' : ''}</h3><p>${c.desc}</p><small>${c.members} متابع</small><button class="channel-follow ${state.subscribed.has(c.name) ? 'following' : ''}" data-subscribe="${c.name}">${state.subscribed.has(c.name) ? 'تتابعها' : 'متابعة القناة'}</button></div></article>`).join('')}</div></div>`, 'القنوات', 'اكتشف'); }

function studioView() { return shell(`<div class="studio-page"><section class="studio-canvas"><div class="camera-frame"><div class="camera-grid"></div><div class="camera-top"><span class="recording-dot"></span> 00:00:12 <button>×</button></div><div class="camera-center"><span class="face-orbit">✦</span><p>اضغط لالتقاط اللحظة</p></div><div class="camera-bottom"><button class="studio-control">⌁<small>سرعة</small></button><button class="capture"><span></span></button><button class="studio-control">◌<small>فلاتر</small></button></div></div></section><aside class="studio-panel"><div class="panel-head"><div><span class="eyebrow">NEXA STUDIO</span><h2>اصنع لحظتك</h2></div><button class="icon-btn">⚙</button></div><div class="mode-switch"><button class="selected">فيديو</button><button>صورة</button><button>بث مباشر</button></div><div class="effects-title"><h3>تأثيرات اليوم</h3><button>الكل</button></div><div class="effects-grid">${['✦','◒','✺','◉','⌁','◇'].map((x, i) => `<button class="effect ${i === 0 ? 'selected' : ''}"><span>${x}</span><small>${['نقي','Glow','نظرة','عكس','حبيبات','حالم'][i]}</small></button>`).join('')}</div><div class="studio-note"><span>${icons.shield}</span><p><strong>DeepGuard نشط</strong><br />محتواك محمي قبل النشر.</p></div></aside></div>`, 'الاستوديو', 'إنشاء'); }

function communitiesView() { return shell(`<div class="community-page"><div class="page-heading"><div><span class="eyebrow">مجتمعاتك</span><h2>معاً، نصنع أكثر</h2><p>مساحات آمنة للحوار والعمل المشترك.</p></div><button class="primary-btn">${icons.plus} مجتمع جديد</button></div><div class="community-layout"><section><article class="community-feature"><div class="community-banner"><span>◈</span><small>مساحة موصى بها</small></div><div class="community-content">${avatar('ت','purple','large')}<div><h2>تقنية الغد</h2><p>نناقش الأدوات التي ستصنع عالمنا القادم.</p><div class="member-stack">${['م','ر','س','ن'].map((x,i) => avatar(x, ['coral','blue','green','yellow'][i])).join('')}<small>+ 4.2K عضو</small></div></div><button class="join-btn">انضمام</button></div></article></section><aside class="roles-panel"><h3>نشاط المجتمع</h3><div class="activity-item"><span class="activity-icon blue">↗</span><p><strong>سارة</strong> نشرت في <b>#التصميم</b><small>منذ 4 دقائق</small></p></div><div class="activity-item"><span class="activity-icon coral">✦</span><p><strong>ياسر</strong> بدأ موضوعاً جديداً<small>منذ 18 دقيقة</small></p></div><div class="activity-item"><span class="activity-icon green">♧</span><p><strong>ريم</strong> انضمت للمجتمع<small>منذ 42 دقيقة</small></p></div></aside></div></div>`, 'المجتمعات', 'انتمِ'); }
function spacesView() { return shell(`<div class="spaces-page"><div class="page-heading"><div><span class="eyebrow">مساحة واحدة</span><h2>القنوات والمجتمعات</h2><p>كل مساحاتك في قائمة واحدة.</p></div><button class="primary-btn">${icons.plus} إنشاء مساحة</button></div><div class="space-tabs"><button class="selected">الكل</button><button>القنوات</button><button>المجتمعات</button></div><div class="space-grid">${channels.map(channel => `<article class="space-card"><div class="space-icon ${channel.color}">${channel.avatar}</div><div><h3>${channel.name}</h3><p>${channel.desc}</p><small>${channel.members} متابع</small></div><button class="follow-btn" data-subscribe="${channel.name}">${state.subscribed.has(channel.name) ? 'تتابع' : 'متابعة'}</button></article>`).join('')}<article class="space-card community-space"><div class="space-icon purple">◈</div><div><h3>تقنية الغد</h3><p>مجتمع للحوار والعمل المشترك.</p><small>4.2K عضو</small></div><button class="follow-btn">انضمام</button></article></div></div>`, 'المساحات', 'استكشف'); }
function profileEditView() { const user = currentUser(); return shell(`<div class="profile-edit-page"><div class="page-heading"><div><span class="eyebrow">ملفك الشخصي</span><h2>عدّل هويتك</h2><p>غيّر الاسم واليوزر والنبذة في أي وقت.</p></div></div><form class="profile-form" data-profile-edit-form><label>الاسم المعروض<input name="displayName" value="${user.displayName || ''}" required minlength="2" maxlength="30" /></label><label>اسم المستخدم<input name="username" value="${user.username || ''}" pattern="[A-Za-z0-9_]+" required minlength="3" maxlength="20" /><small class="field-hint">حروف إنجليزية وأرقام و _ فقط</small></label><label>النبذة<textarea name="bio" maxlength="120" placeholder="اكتب نبذة قصيرة">${user.bio || ''}</textarea></label><button class="auth-submit" type="submit">حفظ التغييرات <span>←</span></button></form></div>`, 'الملف الشخصي', 'حسابك'); }

function profileView() {
  const user = currentUser();
  const ownVideos = state.userVideos.filter(video => video.authorEmail === user.email);
  const likedVideos = state.userVideos.filter(video => state.liked.has(video.id));
  const visibleVideos = ownVideos;
  const grid = visibleVideos.length ? visibleVideos.map((video, index) => `<button class="profile-video-tile" data-profile-video="${video.id}" style="--tile-hue:${index % 3}"><video src="${video.src}" muted preload="metadata"></video><span class="tile-gradient"></span><strong>${video.title}</strong><small>♡ ${state.liked.has(video.id) ? 1 : 0} · ${video.views || 'جديد'}</small></button>`).join('') : `<div class="profile-grid-empty"><span>${icons.studio}</span><p>لم تنشر فيديوهات بعد.</p><button class="primary-btn" data-nav="studio">إنشاء أول فيديو <span>←</span></button></div>`;
  return shell(`<div class="profile-page"><section class="profile-hero"><div class="profile-identity">${avatar(user.avatar, user.color, 'profile-avatar')}<div><h2>${user.displayName || user.username} ${verificationBadge(user)}</h2><p>@${user.username}</p><small>${user.bio || 'أهلاً بك في ملفي على NEXA.'}</small></div></div><div class="profile-actions"><button class="profile-edit-trigger" data-profile-edit>${icons.settings}<span>تعديل البروفايل</span></button><button class="share-profile" data-share-profile>${icons.share}<span>مشاركة</span></button></div><div class="profile-stats-row"><button data-profile-stat="followers"><strong>${user.followers || 0}</strong><small>المتابعون</small></button><button data-profile-stat="following"><strong>${state.subscribed.size}</strong><small>يتابع</small></button><button><strong>${likedVideos.length}</strong><small>الإعجابات</small></button></div></section><div class="profile-tabs"><button class="selected">الفيديوهات <b>${ownVideos.length}</b></button><button>المعجب بها</button><button>المحفوظة</button></div><section class="profile-grid">${grid}</section></div>`, 'البروفايل', 'حسابك');
}

function developerView() {
  const authenticated = isAuthenticated() || state.devUnlocked;
  const boss = claimDeveloperBoss();
  return `<div class="developer-shell"><header class="developer-top"><div class="brand"><span class="brand-mark">N</span><span>NEXA / DEV</span></div><span class="dev-status"><i></i> ${boss ? 'Boss access granted' : 'Awaiting boss approval'}</span></header><main class="developer-main">${!authenticated ? `<section class="developer-gate"><span class="dev-lock">${icons.shield}</span><span class="eyebrow">PRIVATE DEVELOPER PORTAL</span><h1>سجّل الدخول<br /><em>للمطالبة بالوصول.</em></h1><p>أول مستخدم مسجل يدخل هذه البوابة يصبح البوس. الزوار لا يحصلون على صلاحيات.</p><button class="dev-primary" data-dev-login>تسجيل الدخول <span>←</span></button>` : boss ? `<section class="developer-hero"><span class="eyebrow">PRIVATE DEVELOPER PORTAL</span><h1>ابنِ NEXA<br /><em>من الداخل.</em></h1><p>أصبحت أول Boss في بوابة NEXA. لديك صلاحية إدارة المطورين وإعدادات النظام.</p><div class="boss-chip">★ Boss / Founder</div></section><section class="developer-grid"><article class="dev-card"><span class="dev-card-icon green">⌁</span><small>CORE SYSTEMS</small><h3>الخدمات الأساسية</h3><p>PostgreSQL · Redis · MinIO</p><strong>متصلة</strong></article><article class="dev-card"><span class="dev-card-icon yellow">✦</span><small>AI LAYER</small><h3>DeepGuard / HyperBrain</h3><p>المراقبة والتوصيات الذكية</p><strong>جاهزة للتهيئة</strong></article><article class="dev-card"><span class="dev-card-icon blue">⬢</span><small>ACCESS MODEL</small><h3>Boss approval</h3><p>أنت تملك قرار الموافقة</p><strong>محمية</strong></article></section>` : `<section class="developer-gate"><span class="dev-lock">⬢</span><span class="eyebrow">REQUEST PENDING</span><h1>البوابة محجوزة<br /><em>بواسطة البوس.</em></h1><p>أول مستخدم دخل الرابط حصل على صلاحية البوس. يمكنك طلب الانضمام من الحساب المصرح.</p><button class="dev-primary" data-dev-action="request">طلب الانضمام <span>←</span></button></section>`}<section class="developer-note"><span>${icons.shield}</span><div><strong>منطقة خاصة</strong><p>لا تضع مفاتيح API أو أسرار البيئة داخل الواجهة.</p></div></section><a href="/" class="dev-back">العودة إلى التطبيق</a></main></div>`;
}

function developerAppView() {
  return shell(`<div class="developer-app-page"><section class="developer-app-hero"><span class="eyebrow">BOSS CONTROL CENTER</span><h2>مركز المطورين</h2><p>تحكم في تكاملات NEXA وتحدث مع مساعد DeepSeek.</p><div class="boss-chip">★ Boss / Founder</div></section><section class="integration-panel"><div class="section-heading"><h3>تفعيل APIs</h3><small>المفاتيح لا تحفظ في المتصفح</small></div><form class="integration-form" data-integration-form><label>DeepSeek API Key<input name="deepseekApiKey" type="password" placeholder="sk-..." autocomplete="off" /></label><label>Google Client ID<input name="googleClientId" placeholder="...apps.googleusercontent.com" autocomplete="off" /></label><label>Google Client Secret<input name="googleClientSecret" type="password" placeholder="GOCSPX-..." autocomplete="off" /></label><button class="dev-primary" type="submit">حفظ وتفعيل فورًا <span>✓</span></button></form><div class="integration-status"><span data-integration-status>جاري قراءة الحالة...</span></div></section><section class="developer-chat"><div class="section-heading"><h3>DeepSeek Dev Assistant</h3><small>اقتراحات آمنة: فحص، بناء، اختبار</small></div><div class="dev-chat-log" data-dev-chat-log><p class="dev-chat-message assistant">أضف مفتاح DeepSeek ثم اكتب مشكلة أو طلب تطوير.</p></div><form class="dev-chat-form" data-dev-chat-form><input name="message" placeholder="مثال: افحص مشكلة البناء واقترح إصلاحًا" required maxlength="2000" /><button class="dev-primary" type="submit">إرسال</button></form></section><section class="developer-lab"><div class="section-heading"><h3>مختبر التجارب</h3><small>Draft ثم معاينة ثم تفعيل أو إلغاء</small></div><form class="experiment-form" data-experiment-form><input name="name" placeholder="اسم التجربة" required maxlength="80" /><input name="description" placeholder="ما الذي ستختبره؟" maxlength="500" /><button class="dev-primary" type="submit">إنشاء تجربة</button></form><div class="experiment-list" data-experiment-list><p>جاري تحميل التجارب...</p></div></section><div class="developer-app-grid"><article class="dev-card"><span class="dev-card-icon green">⌁</span><small>CORE SYSTEMS</small><h3>حالة الخدمات</h3><p>PostgreSQL · Redis · MinIO</p><strong>متصلة</strong></article><article class="dev-card"><span class="dev-card-icon yellow">✦</span><small>AI CONTROLS</small><h3>DeepGuard وHyperBrain</h3><p>التفعيل من الخادم</p><button class="dev-toggle active">مفعّل</button></article><article class="dev-card"><span class="dev-card-icon blue">⬢</span><small>GOOGLE OAUTH</small><h3>تسجيل الدخول</h3><p>يظهر الزر عند ضبط OAuth</p><strong>جاهز</strong></article></div><section class="developer-settings"><div><strong>رابط البوابة الخاصة</strong><small>/dev متاح للفريق التقني</small></div><button class="dev-outline" data-copy-dev-link>نسخ الرابط</button></section></div>`, 'المطورين', 'صلاحيات البوس');
}

function render() {
  if (window.location.pathname === '/dev' && state.devUnlocked && state.devOwner) {
    document.querySelector('#app').innerHTML = developerView();
    bindEvents();
    return;
  }
  if (window.location.pathname === '/dev') window.history.replaceState({}, '', '/');
  if (state.activeUser?.profileSetup === false && state.deviceTrusted) state.authScreen = 'forced-profile';
  if (state.authScreen === 'forced-profile') {
    document.querySelector('#app').innerHTML = forcedNameView();
    bindEvents();
    return;
  }
  if ((!state.activeUser && ['login', 'register', 'device'].includes(state.authScreen)) || (state.activeUser && !state.deviceTrusted)) {
    const authViews = { login: loginView, register: registerView, device: deviceBindView };
    document.querySelector('#app').innerHTML = state.authScreen === 'device' ? authViews.device() : authViews[state.authScreen]();
    bindEvents();
    return;
  }
  const views = { feed: feedView, messages: messagesView, studio: studioView, spaces: spacesView, profile: profileView, 'profile-edit': profileEditView, developers: developerAppView };
  document.querySelector('#app').innerHTML = views[state.active](); bindEvents();
}
function toast(message) { state.toast = message; const el = document.createElement('div'); el.className = 'toast'; el.textContent = message; document.body.appendChild(el); setTimeout(() => el.remove(), 2200); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function setupVideoAutoplay() {
  const stream = document.querySelector('.stream-list');
  if (!stream) return;
  const videosOnPage = [...stream.querySelectorAll('[data-video]')];
  const startVideo = video => { video.muted = true; video.defaultMuted = true; video.play().catch(() => {}); };
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    const video = entry.target;
    if (entry.isIntersecting && entry.intersectionRatio >= 0.65) {
      videosOnPage.filter(item => item !== video).forEach(item => item.pause());
      startVideo(video);
    } else {
      video.pause();
    }
  }), { root: stream, threshold: [0.2, 0.65, 0.9] });
  videosOnPage.forEach(video => { observer.observe(video); video.addEventListener('loadeddata', () => { if (video.closest('.video-card')?.getBoundingClientRect().top >= stream.getBoundingClientRect().top - 20) startVideo(video); }, { once: true }); });
  if (videosOnPage[0]) startVideo(videosOnPage[0]);
}
function bindEvents() {
  document.querySelectorAll('[data-local-google]').forEach(button => button.addEventListener('click', () => toast('Google OAuth يحتاج Backend؛ النسخة الحالية تعمل محليًا فقط.')));
  document.querySelectorAll('[data-logo-trigger]').forEach(button => button.addEventListener('click', async () => {
    if (state.devUnlocked && state.devOwner) return;
    state.logoPresses += 1;
    clearTimeout(state.logoPressTimer);
    state.logoPressTimer = setTimeout(() => { state.logoPresses = 0; }, 900);
    if (state.logoPresses < 3) return;
    state.logoPresses = 0;
    state.devUnlocked = true;
    state.devOwner = true;
    localStorage.setItem('nexa-dev-unlocked', 'true');
    localStorage.setItem('nexa-dev-owner', 'true');
    if (state.activeUser) { state.activeUser.role = 'boss'; state.activeUser.developerStatus = 'approved'; const user = state.users.find(item => item.email === state.activeUser.email); if (user) Object.assign(user, { role: 'boss', developerStatus: 'approved' }); persistAuth(); }
    state.active = 'developers';
    toast('تم فتح بوابة المطورين بصلاحية Boss');
    render();
  }));
  const integrationForm = document.querySelector('[data-integration-form]');
  if (integrationForm) integrationForm.addEventListener('submit', event => { event.preventDefault(); localStorage.setItem('nexa-local-integrations', 'configured'); document.querySelector('[data-integration-status]').textContent = 'مفعّل محليًا على هذا المتصفح'; toast('تم حفظ إعدادات الواجهة محليًا'); });
  const experimentForm = document.querySelector('[data-experiment-form]');
  const experimentList = document.querySelector('[data-experiment-list]');
  if (experimentForm) experimentForm.addEventListener('submit', event => { event.preventDefault(); const values = Object.fromEntries(new FormData(experimentForm)); experimentList.insertAdjacentHTML('beforeend', `<article class="experiment-row"><div><strong>${escapeHtml(values.name)}</strong><small>${escapeHtml(values.description || '')}</small><b>draft</b></div><div><button class="dev-toggle active" data-experiment-action="activate">تفعيل</button><button class="dev-outline" data-experiment-action="cancel">إلغاء</button></div></article>`); experimentForm.reset(); toast('تم إنشاء تجربة محلية'); });
  const chatForm = document.querySelector('[data-dev-chat-form]');
  if (chatForm) chatForm.addEventListener('submit', event => { event.preventDefault(); const input = chatForm.elements.message; const message = input.value.trim(); if (!message) return; const log = document.querySelector('[data-dev-chat-log]'); log.insertAdjacentHTML('beforeend', `<p class="dev-chat-message user">${escapeHtml(message)}</p><p class="dev-chat-message assistant">هذه نسخة Frontend فقط. تم حفظ التجربة محليًا، ولا يوجد اتصال AI بدون Backend.</p>`); input.value = ''; log.scrollTop = log.scrollHeight; });
  document.querySelectorAll('[data-copy-dev-link]').forEach(button => button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(`${location.origin}/dev`); toast('تم نسخ رابط المطورين'); } catch { toast(`${location.origin}/dev`); } }));
  document.querySelectorAll('[data-dev-action]').forEach(button => button.addEventListener('click', () => { toast('أرسل طلبك إلى البوس من بوابة API الخاصة بالمطورين.'); }));
  document.querySelectorAll('[data-dev-login]').forEach(button => button.addEventListener('click', () => { state.authScreen = 'login'; state.authPrompt = 'سجّل الدخول للمطالبة ببوابة المطورين'; window.history.replaceState({}, '', '/'); render(); }));
  const studioPanel = document.querySelector('.studio-panel');
  if (studioPanel && !document.querySelector('#video-upload')) {
    studioPanel.insertAdjacentHTML('beforeend', '<div class="upload-control"><input id="video-upload" type="file" accept="video/*" hidden /><button type="button" data-upload-video>رفع فيديو من جهازك <span>↑</span></button><small>سيظهر الفيديو مباشرة في استكشافك.</small></div>');
  }
  document.querySelectorAll('[data-upload-video]').forEach(button => button.addEventListener('click', () => document.querySelector('#video-upload')?.click()));
  document.querySelectorAll('#video-upload').forEach(input => input.addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (!file || !file.type.startsWith('video/')) return;
    const user = currentUser();
    state.userVideos.unshift({ id: `user-${Date.now()}`, src: URL.createObjectURL(file), author: user.username, authorEmail: user.email, handle: `@${user.username}`, avatar: user.avatar, color: user.color, title: 'فيديو جديد من استوديو NEXA', tags: '#NEXA #منشوري', views: 'جديد' });
    state.active = 'feed';
    render();
    toast('تم نشر الفيديو في استكشافك');
  }));
  document.querySelectorAll('[data-auth-screen]').forEach(el => el.addEventListener('click', () => { state.authScreen = el.dataset.authScreen; state.authPrompt = ''; state.authError = ''; render(); }));
  document.querySelectorAll('[data-profile-edit]').forEach(el => el.addEventListener('click', () => { if (!isAuthenticated()) { state.authScreen = 'login'; state.authPrompt = 'سجّل الدخول لتعديل ملفك'; render(); return; } state.active = 'profile-edit'; render(); }));
  document.querySelectorAll('[data-share-profile]').forEach(el => el.addEventListener('click', async () => { const link = `${location.origin}/profile/${currentUser().username}`; try { await navigator.clipboard.writeText(link); toast('تم نسخ رابط البروفايل'); } catch { toast(link); } }));
  document.querySelectorAll('[data-profile-video]').forEach(el => el.addEventListener('click', () => { const video = state.userVideos.find(item => item.id === el.dataset.profileVideo); if (!video) return; state.userVideos = [video, ...state.userVideos.filter(item => item.id !== video.id)]; state.active = 'feed'; render(); }));
  document.querySelectorAll('[data-toggle-password]').forEach(el => el.addEventListener('click', () => { const input = el.parentElement.querySelector('input'); input.type = input.type === 'password' ? 'text' : 'password'; el.textContent = input.type === 'password' ? 'إظهار' : 'إخفاء'; }));
  const authForm = document.querySelector('[data-auth]');
  if (authForm) authForm.addEventListener('submit', event => { event.preventDefault(); const form = new FormData(authForm); state.authLoading = true; state.authError = ''; render(); setTimeout(() => { const email = String(form.get('email')).trim().toLowerCase(); const password = String(form.get('password')); if (authForm.dataset.auth === 'login') { const user = state.users.find(item => item.email === email && item.password === password); if (!user) { state.authLoading = false; state.authError = 'البريد الإلكتروني أو كلمة المرور غير صحيحة.'; render(); return; } state.pendingUser = user; } else { const identity = randomIdentity(); if (state.users.some(item => item.email === email)) { state.authLoading = false; state.authError = 'هذا البريد مستخدم بالفعل.'; render(); return; } const user = { id: `usr_${Date.now()}`, displayName: identity.displayName, username: identity.username, email, password, avatar: identity.displayName.slice(-1), color: ['coral', 'blue', 'green'][state.users.length % 3], verification: state.users.length < 3 ? 'gold' : 'standard', followers: 0, profileSetup: false, role: state.users.length === 0 ? 'boss' : 'developer', developerStatus: state.users.length === 0 ? 'approved' : 'pending' }; state.users.push(user); state.pendingUser = user; persistAuth(); } state.authLoading = false; state.authScreen = authForm.dataset.auth === 'register' ? 'forced-profile' : 'device'; render(); }, 450); });
  const profileSetupForm = document.querySelector('[data-profile-setup]'); if (profileSetupForm) profileSetupForm.addEventListener('submit', event => { event.preventDefault(); saveProfileForm(profileSetupForm, true); });
  const profileEditForm = document.querySelector('[data-profile-edit-form]'); if (profileEditForm) profileEditForm.addEventListener('submit', event => { event.preventDefault(); saveProfileForm(profileEditForm, false); });
  document.querySelectorAll('[data-bind-device]').forEach(el => el.addEventListener('click', () => { state.authLoading = true; render(); setTimeout(() => { state.activeUser = state.pendingUser; state.accounts = [...new Map([...state.accounts, state.activeUser].map(user => [user.email, user])).values()]; state.deviceTrusted = true; state.authLoading = false; state.authScreen = state.activeUser.profileSetup === false ? 'forced-profile' : 'guest'; persistAuth(); render(); toast('تم توثيق الجهاز وفتح NEXA'); }, 450); }));
  document.querySelectorAll('[data-add-account]').forEach(el => el.addEventListener('click', () => { state.authScreen = 'login'; state.activeUser = null; state.deviceTrusted = false; state.pendingUser = null; render(); }));
  document.querySelectorAll('[data-switch-account]').forEach(el => el.addEventListener('click', () => { if (state.accounts.length < 2) { toast('أضف حساباً آخر أولاً'); return; } const index = state.accounts.findIndex(user => user.email === state.activeUser.email); state.activeUser = state.accounts[(index + 1) % state.accounts.length]; persistAuth(); render(); toast(`تم التبديل إلى ${state.activeUser.username}`); }));
  document.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => { const destination = el.dataset.nav; if ((el.dataset.requiresAuth !== undefined || ['studio', 'messages', 'communities'].includes(destination)) && !isAuthenticated()) { state.authScreen = 'login'; state.authPrompt = 'سجّل الدخول لاستخدام هذه الميزة'; render(); return; } state.active = destination; render(); }));
  document.querySelectorAll('[data-like]').forEach(el => el.addEventListener('click', () => { const id = el.dataset.like; state.liked.has(id) ? state.liked.delete(id) : state.liked.add(id); render(); }));
  document.querySelectorAll('[data-save]').forEach(el => el.addEventListener('click', () => { const id = el.dataset.save; state.saved.has(id) ? state.saved.delete(id) : state.saved.add(id); toast(state.saved.has(id) ? 'تم حفظ المنشور' : 'أزيل من المحفوظات'); render(); }));
  document.querySelectorAll('.video-actions .action:not([data-like]):not([data-save])').forEach(el => el.addEventListener('click', () => { if (!isAuthenticated()) { state.authScreen = 'login'; state.authPrompt = 'سجّل الدخول للتعليق والمشاركة'; render(); } }));
  document.querySelectorAll('[data-follow-person]').forEach(el => el.addEventListener('click', () => { const person = el.dataset.followPerson; state.subscribed.has(person) ? state.subscribed.delete(person) : state.subscribed.add(person); persistFollowing(); toast(state.subscribed.has(person) ? 'تمت متابعة الشخص' : 'تم إلغاء المتابعة'); render(); }));
  document.querySelectorAll('[data-subscribe]').forEach(el => el.addEventListener('click', () => { const name = el.dataset.subscribe; state.subscribed.has(name) ? state.subscribed.delete(name) : state.subscribed.add(name); toast(state.subscribed.has(name) ? `أصبحت تتابع ${name}` : `ألغيت متابعة ${name}`); render(); }));
  document.querySelectorAll('[data-play]').forEach(el => el.addEventListener('click', event => { event.stopPropagation(); const video = document.querySelector(`[data-video="${el.dataset.play}"]`); if (!video) return; if (video.paused) video.play().catch(() => {}); else video.pause(); }));
  document.querySelectorAll('[data-auth-action]').forEach(el => el.addEventListener('click', () => { if (!isAuthenticated()) { state.authScreen = 'login'; state.authPrompt = 'سجّل الدخول للتفاعل مع الفيديو'; render(); } }));
  document.querySelectorAll('[data-chat]').forEach(el => el.addEventListener('click', () => { state.selectedChat = Number(el.dataset.chat); render(); }));
  const form = document.querySelector('.composer'); if (form) form.addEventListener('submit', e => { e.preventDefault(); const input = document.querySelector('#message-input'); if (input.value.trim()) { state.sentMessages.push(input.value.trim()); input.value = ''; render(); } });
  const streamList = document.querySelector('.stream-list'); if (streamList) { let startY = 0; streamList.addEventListener('touchstart', event => { startY = event.touches[0].clientY; }, { passive: true }); streamList.addEventListener('touchend', event => { const delta = startY - event.changedTouches[0].clientY; if (Math.abs(delta) > 60) { const cards = [...streamList.querySelectorAll('.video-card')]; const current = Math.max(0, cards.findIndex(card => card.getBoundingClientRect().top >= streamList.getBoundingClientRect().top)); const next = delta > 0 ? cards[Math.min(current + 1, cards.length - 1)] : cards[Math.max(current - 1, 0)]; next?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }, { passive: true }); }
  setupVideoAutoplay();
}

render();