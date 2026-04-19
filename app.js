// ===== 設定 =====
const SUPABASE_URL = 'https://cktxrkkeqdazcvamphhh.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrdHhya2tlcWRhemN2YW1waGhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNDU1MTYsImV4cCI6MjA4OTkyMTUxNn0.DlCMM0_Qu4qNSZ6znekMEmvXHXSU6QAD1wvyFFEIX78';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const CLAUDE_MODEL_FAST = 'claude-haiku-4-5-20251001';

let currentPatient = null;
let observations = [];

// ===== ユーティリティ =====
function showStatus(msg, duration = 3000) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.classList.add('show');
  setTimeout(() => bar.classList.remove('show'), duration);
}

function copyText(id) {
  const text = document.getElementById(id).innerText;
  navigator.clipboard.writeText(text).then(() => showStatus('✅ コピーしました'));
}

function setTodayDate() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('visit-date').value = today;
}

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
}

// ===== タブ切り替え =====
function switchTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.getAttribute('onclick') === "switchTab('" + tab + "')") b.classList.add('active');
  });
  // 患者一覧に戻ったら個人タブを隠して一括タブを表示
  if (tab === 'patients') { window.scheduleViewDate = new Date().toISOString().split('T')[0]; loadTodaySchedule();
    ['tab-record','tab-keikaku','tab-hokoku'].forEach(function(id) {
      var el = document.getElementById(id); if(el) el.style.display = 'none';
    });
    ['tab-bulk-keikaku','tab-bulk-hokoku','tab-register'].forEach(function(id) {
      var el = document.getElementById(id); if(el) el.style.display = '';
    });
    currentPatient = null;
    // 編集モードをリセット・フォームをクリア
    window.editingPatientId = null;
    clearRegForm();
    var saveBtn = document.querySelector('button[onclick="savePatient()"]');
    if (saveBtn) { saveBtn.innerHTML = '💾 この患者を保存する'; saveBtn.style.background = ''; }
  }
  if (tab === 'register') {
    // 編集モードでない場合はフォームをクリア
    if (!window.editingPatientId) {
      clearRegForm();
    }
  }
  if (tab === 'keikaku') { loadDocuments('keikaku'); }
  if (tab === 'hokoku') { loadDocuments('hokoku'); var rm = document.getElementById('report-month'); if(rm) rm.value = getCurrentMonth(); }
  if (tab === 'bulk-keikaku') { loadBulkPatientsList('keikaku'); var d = document.getElementById('bulk-keikaku-date'); if(d) d.value = new Date().toISOString().split('T')[0]; }
  if (tab === 'bulk-hokoku') { loadBulkPatientsList('hokoku'); var m = document.getElementById('bulk-month'); if(m) m.value = getCurrentMonth(); }
  if (tab === 'feedback') loadFeedback();
}

// ===== Supabase API =====
async function supabaseFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : ''
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || res.statusText);
  }
  return res.json().catch(() => ({}));
}

// ===== Claude API =====
// ===== 匿名化処理 =====
function anonymize(text) {
  if (!text) return text;
  // 患者名を「患者A」に置換（currentPatientの氏名）
  if (currentPatient && currentPatient.name) {
    var name = currentPatient.name;
    // フルネーム・苗字・名前それぞれ置換
    var parts = name.split(/\s+/);
    text = text.split(name).join('患者A');
    if (parts.length > 1) {
      text = text.split(parts[0]).join('患者A');
      text = text.split(parts[1]).join('患者A');
    }
  }
  // 年齢は残す（医療的に必要）
  // 電話番号パターンを除去（先に長いパターンから）
  text = text.replace(/\d{2,4}-\d{2,4}-\d{4}/g, '電話***');
  text = text.replace(/\d{3}-\d{4}(?!-)/g, '〒***');
  return text;
}

async function callClaude(systemPrompt, userPrompt, useFast, temperature) {
  // APIに送る前に匿名化
  var anonUserPrompt = anonymize(userPrompt);
  var model = useFast ? CLAUDE_MODEL_FAST : CLAUDE_MODEL;
  var body = {
    model: model,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: anonUserPrompt }]
  };
  if (temperature !== undefined) body.temperature = temperature;
  const res = await fetch('/.netlify/functions/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || res.statusText);
  }
  const data = await res.json();
  return data.content[0].text;
}


// ===== 観察テンプレート読み込み（SOAP形式） =====
async function loadObsTemplate() {
  // PT/OT/STは専用テンプレート
  if (currentStaff === 'pt') { loadPTTemplate(); return; }
  if (currentStaff === 'ot') { loadOTTemplate(); return; }
  if (currentStaff === 'st') { loadSTTemplate(); return; }
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  var p = currentPatient;
  var diagnosis = p.main_diagnosis || '';
  var nl = '\n';

  var t = '【S：主観的情報】' + nl;
  t += '本人の訴え：' + nl;
  t += '家族・介護者からの情報：' + nl + nl;

  t += '【O：客観的情報】' + nl;
  t += '＜バイタル＞' + nl;
  t += '体温：　 血圧：　 脈拍：　 SpO2：　 呼吸数：' + nl;
  t += '意識レベル：' + nl + nl;

  t += '＜呼吸状態＞' + nl;
  t += '呼吸音：' + nl;
  t += '肺雑音：' + nl + nl;

  t += '＜消化器＞' + nl;
  t += '最終排便：　 腹部膨満感：　 グル音：' + nl;
  t += '食欲・食事摂取量：' + nl;
  t += '水分摂取量：' + nl + nl;

  t += '＜生活状況＞' + nl;
  t += '睡眠：' + nl;
  t += '内服状況：' + nl + nl;

  // 疾患別セクション（固定リスト + AI動的生成）
  var diseaseResult = await getDiseaseItemsAI(diagnosis);
  if (diseaseResult) {
    t += '＜' + diseaseResult.disease + '関連＞' + nl;
    diseaseResult.items.forEach(function(item) {
      var label = item.replace('の確認', '').replace('の有無', '').replace('の状態', '').replace('の程度', '');
      t += label + '：' + nl;
    });
    t += nl;
  }

  t += '【A：アセスメント】' + nl + nl;

  t += '【P：プラン】' + nl;

  document.getElementById('visit-content').value = t;
  showStatus('✅ SOAPテンプレートを読み込みました');
}

// ===== PT/OT/STテンプレート =====
function getPTItems(diagnosis) {
  var d = diagnosis;
  if (/脳梗塞|脳出血|片麻痺/.test(d)) return ['麻痺の程度（Brunnstrom）：','筋緊張・痙縮：','歩行状態・歩行速度：','バランス（静的・動的）：','転倒リスク：','補装具の状態：'];
  if (/パーキンソン/.test(d)) return ['すくみ足・小刻み歩行：','姿勢・体幹バランス：','転倒リスク：','ON/OFF状態：','関節可動域：'];
  if (/骨折|変形性|脊柱/.test(d)) return ['関節可動域（ROM）：','筋力（MMT）：','荷重状況：','疼痛（NRS）：','歩行・移動状態：'];
  if (/心不全|COPD|呼吸/.test(d)) return ['運動耐容能：','息切れ（Borg指数）：','運動前後SpO2：','バイタル変動：'];
  return ['筋力（MMT）：','関節可動域：','バランス：','歩行状態：','疼痛：'];
}
function getOTItems(diagnosis) {
  var d = diagnosis;
  if (/脳梗塞|脳出血|片麻痺/.test(d)) return ['上肢機能（麻痺側）：','手指巧緻性：','半側空間無視：','失行・失認：','食事動作：','更衣動作：'];
  if (/認知症|アルツハイマー/.test(d)) return ['IADL（家事・金銭管理）：','見当識：','BPSD：','日常生活の自立度：','安全管理（火・薬）：'];
  if (/パーキンソン/.test(d)) return ['上肢機能・細かい作業：','書字：','食事動作：','更衣動作：','ON/OFFの影響：'];
  if (/骨折|整形/.test(d)) return ['上肢ROM・筋力：','更衣動作：','整容動作：','入浴動作：'];
  return ['上肢機能：','ADL（食事・更衣・整容）：','IADL：','認知機能：'];
}
function getSTItems(diagnosis) {
  var d = diagnosis;
  if (/脳梗塞|脳出血/.test(d)) return ['嚥下機能（むせ・咽頭残留）：','食形態：','失語（話す・聞く・読む・書く）：','構音障害：','発声・声量：'];
  if (/パーキンソン/.test(d)) return ['嚥下機能：','声量・発声の明瞭度：','構音：','食事ペース：','誤嚥リスク：'];
  if (/認知症/.test(d)) return ['コミュニケーション能力：','理解力：','記憶・注意機能：','嚥下機能：','食形態：'];
  if (/がん|ALS|筋萎縮/.test(d)) return ['嚥下機能：','誤嚥リスク：','栄養摂取状況：','発声・構音：'];
  return ['嚥下機能：','構音・発声：','コミュニケーション能力：','食形態：','誤嚥リスク：'];
}

function loadPTTemplate() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  var nl = '\n';
  var d = currentPatient.main_diagnosis || '';
  var t = '■ 実施内容・アプローチ' + nl;
  t += '主な訓練内容：' + nl;
  t += '訓練時間：' + nl + nl;
  t += '■ 評価（本日）' + nl;
  getPTItems(d).forEach(function(item) { t += item + nl; });
  t += nl;
  t += '■ バイタル（運動前後）' + nl;
  t += '運動前　血圧：　脈拍：　SpO2：' + nl;
  t += '運動後　血圧：　脈拍：　SpO2：' + nl + nl;
  t += '■ 目標達成度・前回比' + nl;
  t += '短期目標の達成状況：' + nl;
  t += '前回との変化：' + nl + nl;
  t += '■ 自主トレ指導' + nl;
  t += '指導内容：' + nl;
  t += '実施状況：' + nl + nl;
  t += '■ 多職種連携・申し送り' + nl;
  document.getElementById('rehab-content').value = t;
  showStatus('✅ PTテンプレートを読み込みました');
}

function loadOTTemplate() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  var nl = '\n';
  var d = currentPatient.main_diagnosis || '';
  var t = '■ 実施内容・アプローチ' + nl;
  t += '主な訓練内容：' + nl;
  t += '訓練時間：' + nl + nl;
  t += '■ ADL・機能評価（本日）' + nl;
  getOTItems(d).forEach(function(item) { t += item + nl; });
  t += nl;
  t += '■ 環境調整' + nl;
  t += '住環境の問題点：' + nl;
  t += '福祉用具の活用：' + nl + nl;
  t += '■ 目標達成度・前回比' + nl;
  t += '短期目標の達成状況：' + nl;
  t += '前回との変化：' + nl + nl;
  t += '■ 家族・介護者への指導' + nl;
  t += '指導内容：' + nl + nl;
  t += '■ 多職種連携・申し送り' + nl;
  document.getElementById('rehab-content').value = t;
  showStatus('✅ OTテンプレートを読み込みました');
}

function loadSTTemplate() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  var nl = '\n';
  var d = currentPatient.main_diagnosis || '';
  var t = '■ 実施内容・アプローチ' + nl;
  t += '主な訓練内容：' + nl;
  t += '訓練時間：' + nl + nl;
  t += '■ 評価（本日）' + nl;
  getSTItems(d).forEach(function(item) { t += item + nl; });
  t += nl;
  t += '■ 嚥下・栄養' + nl;
  t += '食事形態：' + nl;
  t += '食事摂取量：' + nl;
  t += '水分のとろみ：' + nl + nl;
  t += '■ 目標達成度・前回比' + nl;
  t += '短期目標の達成状況：' + nl;
  t += '前回との変化：' + nl + nl;
  t += '■ 家族・介護者への指導' + nl;
  t += '指導内容：' + nl + nl;
  t += '■ 多職種連携・申し送り' + nl;
  document.getElementById('rehab-content').value = t;
  showStatus('✅ STテンプレートを読み込みました');
}

// ===== 前回記録を複写 =====
async function copyLastVisit() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  try {
    var visits = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&order=visit_date.desc&limit=10');
    var isRehab = ['pt','ot','st'].includes(currentStaff);
    var staffLabel = {pt:'PT', ot:'OT', st:'ST'}[currentStaff] || '';
    var targetVisits;
    if (isRehab) {
      // PT/OT/STはそれぞれの記録のみ
      targetVisits = visits.filter(function(v) {
        return v.content && v.content.startsWith('【' + staffLabel + '記録】');
      });
      if (!targetVisits.length) { showStatus('⚠️ 前回の' + staffLabel + '記録がありません'); return; }
    } else {
      // 看護師は看護師記録のみ
      targetVisits = visits.filter(function(v) {
        return v.content && !v.content.startsWith('【PT記録】') && !v.content.startsWith('【OT記録】') && !v.content.startsWith('【ST記録】');
      });
      if (!targetVisits.length) { showStatus('⚠️ 前回の看護記録がありません'); return; }
    }
    var last = targetVisits[0];

    if (isRehab) {
      // リハビリはテンプレート形式ごと複写（rehab-contentフィールドに全文）
      document.getElementById('rehab-content').value = last.content;
      document.getElementById('rehab-adl').value = '';
      document.getElementById('rehab-goal').value = '';
    } else {
      // 看護師はバイタルのみ空白にして複写
      var vitalKeys = ['体温', '血圧', '脈拍', 'SpO2', '呼吸数', '意識レベル'];
      var lines = last.content.split('\n');
      var inVitalSection = false;
      var template = lines.map(function(line) {
        if (line.includes('＜バイタル＞')) { inVitalSection = true; }
        if (line.startsWith('＜') && !line.includes('バイタル')) { inVitalSection = false; }
        if (inVitalSection && line.indexOf('：') > 0) {
          var isVital = vitalKeys.some(function(k) { return line.includes(k); });
          if (isVital) {
            var result = line;
            vitalKeys.forEach(function(k) {
              var re = new RegExp(k + '：[^\s　]*', 'g');
              result = result.replace(re, k + '：');
            });
            return result;
          }
        }
        if (line.includes('【A：アセスメント】')) { return line; }
        if (line.startsWith('← 下の')) { return ''; }
        return line;
      }).join('\n');
      document.getElementById('visit-content').value = template;
    }
    // 申し送りも複写
    if (last.observations) {
      document.getElementById('visit-observations').value = last.observations;
    }
    showStatus('✅ 前回記録（' + last.visit_date + '）を複写しました（バイタルのみ空白）');
  } catch(e) {
    showStatus('⚠️ 複写に失敗しました: ' + e.message, 5000);
  }
}


// ===== サンプル患者登録 =====
async function seedPatients() {
  if (!confirm('サンプル患者10人を登録しますか？\n（すでに登録済みの患者はそのまま残ります）')) return;
  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '登録中...';

  var patients = [
    { name:'田中 花子', age:82, gender:'女性', nurse:'川子', main_diagnosis:'脳梗塞後遺症', medical_history:'高血圧、糖尿病、心房細動', medical_procedures:'吸引、経管栄養（胃瘻）', adl:'移動：車椅子介助、食事：胃瘻管理、排泄：オムツ使用', notes:'長女が主介護者。週2回デイサービス利用。', medicines:'アムロジピン5mg 朝食後\nワーファリン1mg 朝食後\nランソプラゾール15mg 朝食後' },
    { name:'鈴木 一郎', age:76, gender:'男性', nurse:'川子', main_diagnosis:'慢性心不全', medical_history:'高血圧、陳旧性心筋梗塞、慢性腎不全', medical_procedures:'なし', adl:'移動：歩行器使用、食事：自立、排泄：一部介助', notes:'塩分制限6g/日。体重管理要。息子夫婦と同居。', medicines:'フロセミド20mg 朝食後\nビソプロロール2.5mg 朝食後\nエナラプリル5mg 朝食後' },
    { name:'佐藤 幸子', age:79, gender:'女性', nurse:'川子', main_diagnosis:'パーキンソン病（ステージ3）', medical_history:'骨粗鬆症、便秘症', medical_procedures:'なし', adl:'移動：歩行器使用（すくみ足あり）、食事：自立（ムセあり）', notes:'L-ドパ内服時間厳守。ON/OFF現象あり。転倒歴2回。', medicines:'レボドパ・カルビドパ配合錠 1錠 7時・12時・17時\nドンペリドン10mg 毎食前' },
    { name:'山田 義雄', age:85, gender:'男性', nurse:'川子', main_diagnosis:'COPD', medical_history:'肺気腫、高血圧', medical_procedures:'在宅酸素療法（安静時1L/分、労作時2L/分）', adl:'移動：歩行可（労作時息切れ強い）、食事：自立', notes:'SpO2 90%以下で主治医報告。酸素ボンベ管理要。', medicines:'スピリーバ吸入 1日1回\nサルメテロール吸入 1日2回' },
    { name:'伊藤 美代子', age:88, gender:'女性', nurse:'川子', main_diagnosis:'アルツハイマー型認知症', medical_history:'高血圧、骨粗鬆症', medical_procedures:'なし', adl:'移動：歩行可（見守り）、食事：介助、排泄：誘導必要', notes:'夕方の不穏・徘徊あり。長男が主介護。火の管理要注意。', medicines:'ドネペジル5mg 朝食後\nアムロジピン5mg 朝食後' },
    { name:'渡辺 健二', age:68, gender:'男性', nurse:'川子', main_diagnosis:'糖尿病性腎症（透析前期）', medical_history:'2型糖尿病（罹患30年）、高血圧、糖尿病性網膜症', medical_procedures:'血糖自己測定', adl:'移動：自立、食事：自立（制限食）、排泄：自立', notes:'蛋白制限・塩分制限・カリウム制限あり。フットケア要。', medicines:'インスリングラルギン10単位 就寝前\nシタグリプチン50mg 朝食後' },
    { name:'中村 清子', age:74, gender:'女性', nurse:'川子', main_diagnosis:'乳がん末期（骨転移・肺転移）', medical_history:'乳がん術後10年、骨転移、肺転移', medical_procedures:'CVポート（化学療法終了）、疼痛管理', adl:'移動：歩行可（疼痛時制限）、食事：一部介助', notes:'在宅緩和ケア。本人の希望：自宅で最期を迎えたい。NRS 3〜5。', medicines:'オキシコンチン10mg 朝夕\nオキノーム5mg 疼痛時頓用\nデキサメタゾン4mg 朝食後' },
    { name:'小林 茂', age:71, gender:'男性', nurse:'川子', main_diagnosis:'脳出血後遺症（左片麻痺）', medical_history:'高血圧、高脂血症', medical_procedures:'なし', adl:'移動：車椅子（右上下肢のみ使用可）、食事：右手で自立、排泄：介助', notes:'リハビリ継続中（PT週2回）。高次脳機能障害あり。妻が主介護。', medicines:'アムロジピン5mg 朝食後\nロスバスタチン5mg 朝食後\nシロスタゾール100mg 朝夕食後' },
    { name:'加藤 千代', age:91, gender:'女性', nurse:'川子', main_diagnosis:'褥瘡（仙骨部ステージ3）', medical_history:'大腿骨頸部骨折術後、廃用症候群、低栄養', medical_procedures:'褥瘡処置（毎回）、経鼻経管栄養', adl:'移動：全介助（寝たきり）、食事：経鼻経管、排泄：オムツ使用', notes:'褥瘡5×6cm。エアマット使用中。Alb 2.8g/dL。息子が主介護。', medicines:'エレンタールP 1缶/日 経管\nビタミンC 200mg 経管' },
    { name:'松本 勇', age:80, gender:'男性', nurse:'川子', main_diagnosis:'慢性心不全・慢性腎不全（CKD4期）', medical_history:'高血圧、心房細動、2型糖尿病', medical_procedures:'なし', adl:'移動：歩行器使用、食事：自立（制限食）、排泄：一部介助', notes:'水分制限1000ml/日。体重増加1kg/日で主治医報告。妻と二人暮らし。', medicines:'フロセミド40mg 朝食後\nワーファリン2mg 朝食後\nメトホルミン500mg 朝夕食後' }
  ];

  var ok = 0;
  for (var i = 0; i < patients.length; i++) {
    try {
      await supabaseFetch('patients', 'POST', patients[i]);
      ok++;
    } catch(e) {
      console.error(patients[i].name, e);
    }
  }

  document.getElementById('seed-area').style.display = 'none';
  showStatus('✅ ' + ok + '人のサンプル患者を登録しました！');
  loadPatients();
}


// ===== サンプル訪問記録登録 =====
async function seedVisits() {
  if (!confirm('サンプル患者10人に5日分の訪問記録を登録しますか？')) return;
  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '登録中...';

  try {
    var patients = await supabaseFetch('patients?order=name.asc&limit=10');
    if (!patients.length) { showStatus('⚠️ 先に患者を登録してください'); return; }
    var ok = 0;
    var today = new Date();

    var visitData = {
      '田中 花子': [
        [4, '【S：主観的情報】\n本人の訴え：なし（発語困難）\n家族・介護者からの情報：昨日から痰が増えている\n\n【O：客観的情報】\n体温：36.8　血圧：142/88　脈拍：82　SpO2：96\n麻痺の程度：右上下肢麻痺継続\n喀痰：増加傾向\n\n【A：アセスメント】\nSpO2低下・痰増加あり。誤嚥性肺炎の初期症状に注意。\n\n【P：プラン】\n吸引増回。次回SpO2再確認。悪化時主治医報告。'],
        [3, '【S：主観的情報】\n本人の訴え：なし\n家族・介護者からの情報：痰は少し落ち着いた\n\n【O：客観的情報】\n体温：36.5　血圧：138/82　脈拍：78　SpO2：98\n喀痰：減少傾向\n\n【A：アセスメント】\n痰の量改善。バイタル安定。\n\n【P：プラン】\n胃瘻管理継続。家族への介護指導実施。'],
        [2, '【S：主観的情報】\n本人の訴え：なし\n家族・介護者からの情報：特に変わりない\n\n【O：客観的情報】\n体温：36.4　血圧：135/80　脈拍：76　SpO2：98\n\n【A：アセスメント】\n状態安定。変化なし。\n\n【P：プラン】\n現プラン継続。'],
        [1, '【S：主観的情報】\n本人の訴え：なし\n家族・介護者からの情報：表情が穏やか\n\n【O：客観的情報】\n体温：36.6　血圧：140/85　脈拍：80　SpO2：97\n\n【A：アセスメント】\n状態安定。良好。\n\n【P：プラン】\n現プラン継続。'],
        [0, '【S：主観的情報】\n本人の訴え：なし\n家族・介護者からの情報：夜間よく眠れている\n\n【O：客観的情報】\n体温：36.5　血圧：136/82　脈拍：78　SpO2：98\n\n【A：アセスメント】\n状態安定。SpO2改善。\n\n【P：プラン】\n現プラン継続。']
      ],
      '鈴木 一郎': [
        [4, '【S：主観的情報】\n本人の訴え：少し息苦しい\n家族・介護者からの情報：足のむくみが気になる\n\n【O：客観的情報】\n体温：36.3　血圧：152/95　脈拍：88　SpO2：94\n体重：前回比+1.5kg\n下肢浮腫：両側2+\n\n【A：アセスメント】\n体重増加・浮腫増悪・SpO2低下あり。心不全増悪の可能性。主治医報告要。\n\n【P：プラン】\n主治医へ電話報告。利尿剤調整確認。'],
        [3, '【S：主観的情報】\n本人の訴え：昨日より楽になった\n家族・介護者からの情報：利尿剤を増量した\n\n【O：客観的情報】\n体温：36.2　血圧：145/90　脈拍：82　SpO2：96\n体重：前回比-0.8kg\n下肢浮腫：両側1+\n\n【A：アセスメント】\n利尿剤増量後改善傾向。継続観察。\n\n【P：プラン】\n塩分・水分制限の継続指導。'],
        [2, '【S：主観的情報】\n本人の訴え：だいぶ楽\n家族・介護者からの情報：尿量が増えた\n\n【O：客観的情報】\n体温：36.4　血圧：138/86　脈拍：78　SpO2：97\n\n【A：アセスメント】\n改善傾向。状態安定。\n\n【P：プラン】\n現プラン継続。'],
        [1, '【S：主観的情報】\n本人の訴え：普通\n家族・介護者からの情報：特になし\n\n【O：客観的情報】\n体温：36.3　血圧：136/84　脈拍：76　SpO2：97\n\n【A：アセスメント】\n状態安定。\n\n【P：プラン】\n現プラン継続。'],
        [0, '【S：主観的情報】\n本人の訴え：特になし\n家族・介護者からの情報：食欲も戻ってきた\n\n【O：客観的情報】\n体温：36.5　血圧：134/82　脈拍：74　SpO2：98\n体重：前回比±0\n下肢浮腫：軽度\n\n【A：アセスメント】\n状態安定。心不全増悪なし。\n\n【P：プラン】\n現プラン継続。']
      ],
      '佐藤 幸子': [
        [4, '【S：主観的情報】\n本人の訴え：手が震えてスプーンが使いにくい\n家族・介護者からの情報：昨日転倒しそうになった\n\n【O：客観的情報】\n体温：36.4　血圧：125/78　脈拍：72　SpO2：98\n振戦：安静時振戦あり（中等度）\n歩行状態：すくみ足あり\n\n【A：アセスメント】\n振戦増強・転倒リスク高。内服時間の遵守確認要。\n\n【P：プラン】\n転倒予防指導。L-ドパ内服時間の再指導。'],
        [3, '【S：主観的情報】\n本人の訴え：今日は調子がいい\n家族・介護者からの情報：内服時間を守った\n\n【O：客観的情報】\n体温：36.5　血圧：122/76　脈拍：70　SpO2：99\n振戦：軽度\n歩行状態：比較的スムーズ\n\n【A：アセスメント】\nON時間良好。状態改善。\n\n【P：プラン】\n内服管理継続。'],
        [2, '【S：主観的情報】\n本人の訴え：夕方になると体が固くなる\n家族・介護者からの情報：特になし\n\n【O：客観的情報】\n体温：36.3　血圧：124/78　脈拍：68　SpO2：98\n\n【A：アセスメント】\n夕方のOFF症状あり。主治医報告を検討。\n\n【P：プラン】\n内服時間調整について主治医相談。'],
        [1, '【S：主観的情報】\n本人の訴え：特になし\n家族・介護者からの情報：昨日よりは楽そう\n\n【O：客観的情報】\n体温：36.4　血圧：126/78　脈拍：71　SpO2：98\n\n【A：アセスメント】\n状態安定。\n\n【P：プラン】\n現プラン継続。'],
        [0, '【S：主観的情報】\n本人の訴え：便が3日出ていない\n家族・介護者からの情報：食欲は普通\n\n【O：客観的情報】\n体温：36.5　血圧：128/80　脈拍：72　SpO2：98\n最終排便：3日前　腹部膨満感：軽度あり\n\n【A：アセスメント】\n3日排便なし。パーキンソン病患者は便秘になりやすい。\n\n【P：プラン】\nマグミット増量について主治医相談。腹部マッサージ指導。']
      ],
      '山田 義雄': [
        [4, '【S：主観的情報】\n本人の訴え：少し息苦しい\n家族・介護者からの情報：酸素流量を増やした\n\n【O：客観的情報】\n体温：36.6　血圧：148/92　脈拍：90　SpO2：91\n呼吸困難：安静時も軽度あり\n喀痰：黄色痰・量増加\n\n【A：アセスメント】\nSpO2 91%と低下。黄色痰あり。COPD増悪の可能性。主治医報告要。\n\n【P：プラン】\n主治医へ緊急報告。増悪時の対応確認。'],
        [3, '【S：主観的情報】\n本人の訴え：少し楽になった\n家族・介護者からの情報：抗生剤が処方された\n\n【O：客観的情報】\n体温：37.1　血圧：144/90　脈拍：86　SpO2：93\n喀痰：黄色痰・やや減少\n\n【A：アセスメント】\n抗生剤開始後SpO2やや改善。継続観察。\n\n【P：プラン】\n抗生剤内服確認。安静保持。'],
        [2, '【S：主観的情報】\n本人の訴え：だいぶ楽\n\n【O：客観的情報】\n体温：36.8　血圧：140/88　脈拍：82　SpO2：95\n\n【A：アセスメント】\n改善傾向。継続観察。\n\n【P：プラン】\n口すぼめ呼吸指導。'],
        [1, '【S：主観的情報】\n本人の訴え：普通に戻った\n\n【O：客観的情報】\n体温：36.5　血圧：136/86　脈拍：78　SpO2：96\n\n【A：アセスメント】\n状態改善。安定。\n\n【P：プラン】\n現プラン継続。'],
        [0, '【S：主観的情報】\n本人の訴え：特になし\n家族・介護者からの情報：元気そう\n\n【O：客観的情報】\n体温：36.4　血圧：134/84　脈拍：76　SpO2：97\n喀痰：白色・少量\n在宅酸素：安静時1L/分に戻す\n\n【A：アセスメント】\n状態安定。増悪改善。\n\n【P：プラン】\n現プラン継続。禁煙状況確認。']
      ],
      '伊藤 美代子': [
        [4, '【S：主観的情報】\n本人の訴え：ここはどこ？（見当識障害）\n家族・介護者からの情報：昨夜3回徘徊した\n\n【O：客観的情報】\n体温：36.5　血圧：145/88　脈拍：80　SpO2：98\n認知機能：見当識障害悪化\nBPSD：夕方の不穏・徘徊3回\n\n【A：アセスメント】\nBPSD増悪。介護者の疲労も懸念される。主治医報告を検討。\n\n【P：プラン】\n介護者への対応指導。睡眠環境の整備。'],
        [3, '【S：主観的情報】\n本人の訴え：お腹すいた（比較的明瞭）\n家族・介護者からの情報：昨夜は1回だけ起きた\n\n【O：客観的情報】\n体温：36.4　血圧：142/86　脈拍：78　SpO2：98\n認知機能：昨日より穏やか\n\n【A：アセスメント】\nBPSD軽減傾向。継続観察。\n\n【P：プラン】\n日中活動の促進。介護者への休息支援。'],
        [2, '【S：主観的情報】\n本人の訴え：特になし\n\n【O：客観的情報】\n体温：36.6　血圧：140/84　脈拍：76　SpO2：99\n\n【A：アセスメント】\n状態安定。\n\n【P：プラン】\n現プラン継続。'],
        [1, '【S：主観的情報】\n本人の訴え：なし\n家族・介護者からの情報：食欲良好\n\n【O：客観的情報】\n体温：36.3　血圧：138/82　脈拍：74　SpO2：99\n\n【A：アセスメント】\n状態良好。\n\n【P：プラン】\n現プラン継続。'],
        [0, '【S：主観的情報】\n本人の訴え：娘さんはまだ来ないの？（人物認識あり）\n家族・介護者からの情報：今日は調子良さそう\n\n【O：客観的情報】\n体温：36.5　血圧：140/85　脈拍：76　SpO2：98\n認知機能：比較的良好\n服薬管理：介助にて確認\n\n【A：アセスメント】\n状態安定。BPSD改善。\n\n【P：プラン】\n現プラン継続。']
      ],
      '渡辺 健二': [
        [4, '【S：主観的情報】\n本人の訴え：特になし\n\n【O：客観的情報】\n体温：36.4　血圧：135/82　脈拍：74　SpO2：99\n血糖自己測定：朝124mg/dL\nフットケア：足趾間に発赤なし\n内服確認：良好\n\n【A：アセスメント】\n血糖コントロール良好。フットケア問題なし。\n\n【P：プラン】\n現プラン継続。'],
        [3, '【S：主観的情報】\n本人の訴え：特になし\n\n【O：客観的情報】\n体温：36.5　血圧：138/84　脈拍：76　SpO2：99\n血糖：朝118mg/dL\n足部：乾燥あり、保湿剤塗布\n\n【A：アセスメント】\n状態安定。\n\n【P：プラン】\n保湿ケア継続。'],
        [2, '【S：主観的情報】\n本人の訴え：昨日食べ過ぎた\n\n【O：客観的情報】\n体温：36.3　血圧：140/86　脈拍：78　SpO2：98\n血糖：朝132mg/dL\n\n【A：アセスメント】\n血糖やや高め。食事内容確認。\n\n【P：プラン】\n食事制限の再指導。'],
        [1, '【S：主観的情報】\n本人の訴え：特になし\n\n【O：客観的情報】\n体温：36.4　血圧：136/83　脈拍：75　SpO2：99\n血糖：朝115mg/dL\nフットケア実施：問題なし\n\n【A：アセスメント】\n状態良好。\n\n【P：プラン】\n現プラン継続。'],
        [0, '【S：主観的情報】\n本人の訴え：特になし\n\n【O：客観的情報】\n体温：36.5　血圧：134/82　脈拍：73　SpO2：99\n血糖：朝121mg/dL\n内服確認：良好\n\n【A：アセスメント】\n血糖安定。状態良好。\n\n【P：プラン】\n現プラン継続。']
      ],
      '中村 清子': [
        [4, '【S：主観的情報】\n本人の訴え：背中が痛い（NRS 5）\n家族・介護者からの情報：昨夜も眠れなかった\n\n【O：客観的情報】\n体温：36.8　血圧：118/72　脈拍：88　SpO2：95\nNRS：5/10\nオキシコンチン内服確認：良好\n頓用使用：昨夜1回\n\n【A：アセスメント】\n疼痛コントロール不十分。夜間痛あり。主治医報告し増量検討。\n\n【P：プラン】\n主治医へ報告。ポジショニング調整。'],
        [3, '【S：主観的情報】\n本人の訴え：昨日より少し楽（NRS 3）\n家族・介護者からの情報：薬が増量された\n\n【O：客観的情報】\n体温：36.6　血圧：116/70　脈拍：82　SpO2：95\nNRS：3/10\n\n【A：アセスメント】\n増量後疼痛改善傾向。継続観察。\n\n【P：プラン】\n疼痛評価継続。'],
        [2, '【S：主観的情報】\n本人の訴え：まあまあ（NRS 3）\n本人「家にいたい」と話す\n\n【O：客観的情報】\n体温：36.5　血圧：115/70　脈拍：80　SpO2：96\nNRS：3/10\n\n【A：アセスメント】\n疼痛コントロール良好。本人の意向確認。\n\n【P：プラン】\n緩和ケア継続。家族への介護指導。'],
        [1, '【S：主観的情報】\n本人の訴え：特になし（NRS 4）\n\n【O：客観的情報】\n体温：36.7　血圧：114/68　脈拍：82　SpO2：95\nNRS：4/10\n倦怠感：あり\n\n【A：アセスメント】\n倦怠感あり。全身状態観察継続。\n\n【P：プラン】\n現プラン継続。'],
        [0, '【S：主観的情報】\n本人の訴え：今日は少し楽（NRS 3）\n家族・介護者からの情報：昨夜はよく眠れた\n\n【O：客観的情報】\n体温：36.6　血圧：116/70　脈拍：80　SpO2：96\nNRS：3/10\n\n【A：アセスメント】\n疼痛コントロール良好。\n\n【P：プラン】\n緩和ケア継続。']
      ],
      '小林 茂': [
        [4, '【S：主観的情報】\n本人の訴え：左手が動かない（麻痺の認識あり）\n家族・介護者からの情報：PTリハビリを頑張っている\n\n【O：客観的情報】\n体温：36.4　血圧：138/86　脈拍：76　SpO2：98\n左上下肢：完全麻痺・変化なし\n右手ADL：食事自立\n高次脳機能：注意散漫あり\n\n【A：アセスメント】\n麻痺に変化なし。リハビリ継続中。高次脳機能障害による安全リスクあり。\n\n【P：プラン】\nPTとの連携継続。安全環境の確認。'],
        [3, '【S：主観的情報】\n本人の訴え：特になし\n家族・介護者からの情報：昨日PTが来た\n\n【O：客観的情報】\n体温：36.5　血圧：135/84　脈拍：74　SpO2：98\nPTリハビリ後の状態：疲労感あり\n\n【A：アセスメント】\nリハビリ後疲労あり。休息確保。\n\n【P：プラン】\n現プラン継続。'],
        [2, '【S：主観的情報】\n本人の訴え：特になし\n\n【O：客観的情報】\n体温：36.4　血圧：136/84　脈拍：74　SpO2：99\n更衣介助実施\n\n【A：アセスメント】\n状態安定。\n\n【P：プラン】\n現プラン継続。'],
        [1, '【S：主観的情報】\n本人の訴え：特になし\n\n【O：客観的情報】\n体温：36.3　血圧：134/82　脈拍：72　SpO2：99\n\n【A：アセスメント】\n状態良好。\n\n【P：プラン】\n現プラン継続。'],
        [0, '【S：主観的情報】\n本人の訴え：特になし\n家族・介護者からの情報：最近表情が明るい\n\n【O：客観的情報】\n体温：36.5　血圧：136/83　脈拍：74　SpO2：98\n左上下肢：完全麻痺・変化なし\n\n【A：アセスメント】\n精神状態良好。リハビリ継続中。\n\n【P：プラン】\n現プラン継続。']
      ],
      '加藤 千代': [
        [4, '【S：主観的情報】\n本人の訴え：なし（意思疎通困難）\n家族・介護者からの情報：昨日傷の状態が悪いと感じた\n\n【O：客観的情報】\n体温：37.2　血圧：125/78　脈拍：86　SpO2：96\n褥瘡（仙骨部）：5×6cm、滲出液中等量、壊死組織付着\n経鼻経管栄養：注入実施\nエアマット：圧確認・調整\n\n【A：アセスメント】\n微熱あり。褥瘡に感染徴候なし。低栄養が治癒を遅延させている可能性。栄養士と連携要。\n\n【P：プラン】\n褥瘡処置継続。栄養士連携。体位変換2時間毎。'],
        [3, '【S：主観的情報】\n本人の訴え：なし\n\n【O：客観的情報】\n体温：36.8　血圧：122/76　脈拍：82　SpO2：97\n褥瘡：滲出液やや減少、ピンク色肉芽形成あり\n\n【A：アセスメント】\n微熱改善。褥瘡に改善傾向。\n\n【P：プラン】\n処置継続。'],
        [2, '【S：主観的情報】\n本人の訴え：なし\n\n【O：客観的情報】\n体温：36.5　血圧：120/75　脈拍：80　SpO2：97\n褥瘡：4.8×5.8cmに縮小\n\n【A：アセスメント】\n褥瘡縮小傾向。良好。\n\n【P：プラン】\n処置継続。'],
        [1, '【S：主観的情報】\n本人の訴え：なし\n\n【O：客観的情報】\n体温：36.6　血圧：118/74　脈拍：78　SpO2：97\n褥瘡：処置実施\n\n【A：アセスメント】\n状態安定。継続観察。\n\n【P：プラン】\n処置継続。'],
        [0, '【S：主観的情報】\n本人の訴え：なし\n家族・介護者からの情報：特に変わりない\n\n【O：客観的情報】\n体温：36.5　血圧：120/76　脈拍：78　SpO2：98\n褥瘡（仙骨部）：4.5×5.5cm、肉芽形成良好\n経鼻経管栄養：注入問題なし\n\n【A：アセスメント】\n褥瘡改善傾向継続。栄養改善により治癒促進。\n\n【P：プラン】\n処置継続。低栄養管理継続。']
      ],
      '松本 勇': [
        [4, '【S：主観的情報】\n本人の訴え：足がパンパン\n家族・介護者からの情報：体重が増えている\n\n【O：客観的情報】\n体温：36.4　血圧：158/98　脈拍：90　SpO2：95\n体重：前回比+1.2kg\n下腿浮腫：両側著明\n\n【A：アセスメント】\n体重増加・浮腫著明・血圧上昇・SpO2低下。心不全・腎不全増悪の可能性。主治医報告要。\n\n【P：プラン】\n主治医へ緊急報告。水分制限の再徹底。'],
        [3, '【S：主観的情報】\n本人の訴え：少し楽になった\n家族・介護者からの情報：利尿剤が増えた\n\n【O：客観的情報】\n体温：36.3　血圧：148/92　脈拍：84　SpO2：96\n体重：前回比-0.6kg\n下腿浮腫：やや改善\n\n【A：アセスメント】\n利尿剤増量後改善傾向。継続観察。\n\n【P：プラン】\n水分・塩分制限継続指導。'],
        [2, '【S：主観的情報】\n本人の訴え：だいぶ楽\n\n【O：客観的情報】\n体温：36.4　血圧：142/88　脈拍：80　SpO2：97\n体重：前回比-0.4kg\n\n【A：アセスメント】\n改善傾向継続。\n\n【P：プラン】\n現プラン継続。'],
        [1, '【S：主観的情報】\n本人の訴え：普通\n\n【O：客観的情報】\n体温：36.5　血圧：138/86　脈拍：78　SpO2：97\n下腿浮腫：軽度\n\n【A：アセスメント】\n状態安定。\n\n【P：プラン】\n現プラン継続。'],
        [0, '【S：主観的情報】\n本人の訴え：特になし\n家族・介護者からの情報：食欲戻ってきた\n\n【O：客観的情報】\n体温：36.4　血圧：136/84　脈拍：76　SpO2：98\n体重：±0\n下腿浮腫：軽度残存\n\n【A：アセスメント】\n状態安定。各制限の遵守良好。\n\n【P：プラン】\n現プラン継続。']
      ]
    };

    for (var pi = 0; pi < patients.length; pi++) {
      var p = patients[pi];
      var recs = visitData[p.name];
      if (!recs) continue;
      for (var ri = 0; ri < recs.length; ri++) {
        var daysAgo = recs[ri][0];
        var visitContent = recs[ri][1];
        var d = new Date(today);
        d.setDate(d.getDate() - daysAgo);
        var dateStr = d.toISOString().split('T')[0];
        try {
          await supabaseFetch('visits', 'POST', { patient_id: p.id, visit_date: dateStr, content: visitContent });
          ok++;
        } catch(e) { console.error(p.name, e); }
      }
    }

    document.getElementById('seed-visits-area').style.display = 'none';
    showStatus('✅ ' + ok + '件の訪問記録を登録しました！');
  } catch(e) {
    showStatus('⚠️ エラー: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📝 5日分の訪問記録を登録';
  }
}



// ===== スケジュール患者検索 =====
// ===== 検索ユーティリティ =====
function toHiragana(str) {
  return str.replace(/[ァ-ヶ]/g, function(ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0x60);
  });
}
function toKatakana(str) {
  return str.replace(/[ぁ-ゖ]/g, function(ch) {
    return String.fromCharCode(ch.charCodeAt(0) + 0x60);
  });
}
function normalizeQuery(str) {
  // ひらがな・カタカナ両方に統一して比較できるよう正規化
  return toHiragana(str.toLowerCase());
}
function matchPatient(patient, query) {
  if (!query) return true;
  var q = normalizeQuery(query);
  var name = normalizeQuery(patient.name || '');
  var kana = normalizeQuery(patient.kana || '');
  var diag = (patient.main_diagnosis || '').toLowerCase();
  return name.includes(q) || kana.includes(q) || diag.includes(q) ||
         toKatakana(patient.name || '').includes(toKatakana(query));
}
function scorePatient(patient, query) {
  // 前方一致を優先
  var q = normalizeQuery(query);
  var name = normalizeQuery(patient.name || '');
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  return 2;
}

function filterSchPatients(query) {
  var dropdown = document.getElementById('sch-patient-dropdown');
  var patients = window.allPatientsCache || [];
  if (!query.trim()) { dropdown.style.display = 'none'; return; }

  var filtered = patients.filter(function(p) {
    return matchPatient(p, query);
  }).sort(function(a, b) {
    return scorePatient(a, query) - scorePatient(b, query);
  }).slice(0, 10);

  if (!filtered.length) {
    dropdown.innerHTML = '<div style="padding:10px;font-size:13px;color:var(--text-light)">該当なし</div>';
    dropdown.style.display = '';
    return;
  }

  // イベントデリゲーション方式でIDと名前を保持
  window.schPatientMap = {};
  filtered.forEach(function(p) { window.schPatientMap[p.id] = p.name; });

  dropdown.innerHTML = filtered.map(function(p) {
    return '<div data-pid="' + p.id + '" style="padding:10px 12px;font-size:13px;cursor:pointer;border-bottom:1px solid var(--border)">' +
      '<div style="font-weight:700;pointer-events:none">' + p.name + '</div>' +
      '<div style="font-size:11px;color:var(--text-secondary)">' + (p.age||'') + '歳　' + (p.main_diagnosis||'') + '</div>' +
      '</div>';
  }).join('');
  dropdown.style.display = '';
}

function selectSchPatient(id, name) {
  document.getElementById('sch-patient-id').value = id;
  document.getElementById('sch-patient-name-val').value = name;
  document.getElementById('sch-patient-search').value = name;
  document.getElementById('sch-patient-dropdown').style.display = 'none';
}

// ===== 患者一覧フィルタリング =====
var showAllPatients = false;

// ===== 患者一覧 =====
async function loadPatients() {
  const container = document.getElementById('patient-list-container');
  try {
    var patients = await supabaseFetch('patients?order=name.asc');
    // 全患者をキャッシュ
    window.allPatientsCache = patients;
    window.allPatientsForList = patients;
    filterPatientList('');
  } catch(e) {
    container.innerHTML = `<div class="alert alert-error">⚠️ 患者情報の読み込みに失敗しました: ${e.message}</div>`;
  }
}

// 担当者フィールド（複数名を「、,・/ 」区切りで入力可）に自分が含まれるか判定
function isMyPatient(nurseField, myName) {
  if (!nurseField || !myName) return false;
  var nurses = nurseField.split(/[、,・\/\s]+/).map(function(s) { return s.trim(); }).filter(Boolean);
  return nurses.some(function(n) { return n === myName; });
}

function togglePatientFilter() {
  showAllPatients = !showAllPatients;
  var btn = document.getElementById('btn-my-patients');
  if (showAllPatients) {
    btn.textContent = '👥 全患者';
    btn.style.borderColor = 'var(--primary)';
    btn.style.color = 'var(--primary)';
    btn.style.background = '';
    renderPatientList(window.allPatientsForList || []);
  } else {
    btn.textContent = '👤 担当のみ';
    btn.style.borderColor = 'var(--border)';
    btn.style.color = 'var(--text-secondary)';
    btn.style.background = '';
    var myName = currentStaffInfo ? currentStaffInfo.name : '';
    var filtered = (window.allPatientsForList || []).filter(function(p) {
      return !myName || isMyPatient(p.nurse, myName);
    });
    renderPatientList(filtered);
  }
}

function filterPatientList(query) {
  var base = window.allPatientsForList || [];
  if (!showAllPatients && currentStaffInfo) {
    var myName = currentStaffInfo.name;
    base = base.filter(function(p) { return isMyPatient(p.nurse, myName); });
  }
  if (!query.trim()) { renderPatientList(base); return; }
  var filtered = base.filter(function(p) { return matchPatient(p, query); })
    .sort(function(a, b) { return scorePatient(a, query) - scorePatient(b, query); });
  renderPatientList(filtered);
}

function renderPatientList(patients) {
  const container = document.getElementById('patient-list-container');
  if (!patients.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">👥</div>
          <p>患者が登録されていません<br>「患者登録」タブから追加してください</p>
        </div>`;
      return;
    }
    container.innerHTML = '<div class="patient-list">' + patients.map(function(p) {
      return '<div class="patient-item fade-in" style="position:relative">' +
        '<div style="flex:1;display:flex;align-items:center;gap:10px;cursor:pointer" data-id="' + p.id + '" onclick="selectPatientById(this)">' +
        '<div class="patient-avatar">' + (p.gender === '女性' ? '👩' : p.gender === '男性' ? '👨' : '🧑') + '</div>' +
        '<div class="patient-info">' +
        '<h3>' + p.name + '</h3>' +
        '<p>' + (p.age ? p.age + '歳・' : '') + (p.gender || '') + (p.main_diagnosis ? '・' + p.main_diagnosis : '') + (p.nurse ? ' 担当：' + p.nurse : '') + '</p>' +
        '</div>' +
        '<span style="color:var(--text-light);font-size:20px">›</span>' +
        '</div>' +
        '<div style="display:flex;gap:2px;flex-shrink:0">' +
        '<button data-id="' + p.id + '" onclick="editPatientBtn(this)" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0 4px" title="編集">✏️</button>' +
        '<button data-id="' + p.id + '" onclick="deletePatient(this)" style="background:none;border:none;color:#ccc;cursor:pointer;font-size:14px;padding:0 4px" title="削除">🗑</button>' +
        '</div>' +
        '</div>';
    }).join('') + '</div>';
}

async function selectPatientById(el) {
  var id = el.getAttribute('data-id');
  try {
    var latest = await supabaseFetch('patients?id=eq.' + id);
    if (latest.length) selectPatient(latest[0]);
  } catch(e) {
    showStatus('⚠️ 患者情報の取得に失敗しました');
  }
}

async function selectPatient(p) {
  currentPatient = p;
  // 訪問記録・報告書タブを表示
  document.getElementById('tab-record').style.display = '';
  document.getElementById('tab-keikaku').style.display = '';
  document.getElementById('tab-hokoku').style.display = '';
  // 一括タブを隠す・患者登録タブを隠す
  ['tab-bulk-keikaku','tab-bulk-hokoku','tab-register'].forEach(function(id) {
    var el = document.getElementById(id); if(el) el.style.display = 'none';
  });

  // 選択患者情報を表示（内服薬は右サイドカードのみ）
  document.getElementById('selected-patient-info').innerHTML =
    '<div style="display:flex; align-items:center; gap:12px">' +
    '<div class="patient-avatar" style="width:48px;height:48px;font-size:22px">' +
    (p.gender === '女性' ? '👩' : p.gender === '男性' ? '👨' : '🧑') +
    '</div><div>' +
    '<div style="font-size:17px; font-weight:700">' + p.name + '</div>' +
    '<div style="font-size:13px; color:var(--text-secondary)">' + (p.age ? p.age + '歳・' : '') + (p.gender || '') + (p.main_diagnosis ? '・' + p.main_diagnosis : '') + '</div>' +
    '</div></div>';

  setTodayDate();
  var rm = document.getElementById('report-month'); if(rm) rm.value = getCurrentMonth();
  loadDocuments('keikaku');
  loadDocuments('hokoku');
  initNursingChat();
  loadMemos();
  document.getElementById('memo-board').style.display = '';
  var today = new Date().toISOString().split('T')[0];
  if (document.getElementById('keikaku-date')) document.getElementById('keikaku-date').value = today;

  // 計画書・報告書タブの患者名バナーを更新
  var bannerName = p.name + '（' + (p.age||'') + '歳・' + (p.main_diagnosis||'') + '）';
  var kb = document.getElementById('keikaku-patient-banner');
  var kn = document.getElementById('keikaku-patient-name');
  if (kb) kb.style.display = 'flex';
  if (kn) kn.textContent = bannerName;
  var hb = document.getElementById('hokoku-patient-banner');
  var hn = document.getElementById('hokoku-patient-name');
  if (hb) hb.style.display = 'flex';
  if (hn) hn.textContent = bannerName;

  switchTab('record');
  loadVisits();

  // 内服薬サイドリストを更新
  var sideList = document.getElementById('medicine-side-list');
  if (sideList) {
    var medLines = parseMedicinesList(p.medicines);
    if (medLines.length) {
      sideList.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px">' +
        medLines.map(function(med, i) {
          return '<div style="display:flex;align-items:baseline;gap:6px;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">' +
            '<span style="color:var(--primary);font-weight:700;min-width:16px">' + (i+1) + '</span>' +
            '<span>' + med + '</span></div>';
        }).join('') + '</div>';
    } else {
      sideList.innerHTML = '<div style="font-size:13px;color:var(--text-light)">内服薬の登録がありません</div>';
    }
  }
  // 患者切り替え時は詳細エリアを閉じる
  var detail = document.getElementById('patient-detail');
  if (detail) detail.style.display = 'none';
  var detailBtn = document.getElementById('patient-detail-btn');
  if (detailBtn) detailBtn.textContent = '詳細を見る';
  var detailContent = document.getElementById('patient-detail-content');
  if (detailContent) detailContent.innerHTML = '';

  // 患者切り替え時は記録欄・バイタルをクリア＋下書きも削除
  try { localStorage.removeItem('nurseapp_draft'); } catch(e) {}
  var vcEl = document.getElementById('visit-content');
  if (vcEl) vcEl.value = '';
  var obsEl = document.getElementById('visit-observations');
  if (obsEl) obsEl.value = '';
  ['vt-bp-h','vt-bp-l','vt-pulse','vt-temp','vt-spo2','vt-resp'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  var consDisp = document.getElementById('vt-consciousness-display');
  if (consDisp) consDisp.textContent = '清明';
  var cons = document.getElementById('vt-consciousness');
  if (cons) cons.value = '清明';
}

// ===== 共通必須観察項目（疾患問わず毎回確認） =====
const COMMON_ITEMS = [
  // バイタル
  '体温の測定',
  '血圧の測定（左右差・体位変換時の変動も確認）',
  '脈拍の確認（リズム・強さ）',
  'SpO2の測定',
  '呼吸数・呼吸パターンの確認',
  '意識レベルの確認',
  // 全身状態
  '顔色・表情・活気の確認',
  '皮膚の状態（色調・乾燥・発赤・傷の有無）',
  '浮腫の有無（下肢・顔面）',
  '疼痛の有無・程度',
  '倦怠感・不快感の訴え',
  // 消化器
  '最終排便の確認（日時・性状）',
  '腹部膨満感の有無',
  '腸蠕動音（グル音）の確認',
  '食欲・食事摂取量の確認',
  '水分摂取量の確認',
  // 生活
  '睡眠状態の確認',
  '内服薬の服薬状況の確認',
];

// ===== 疾患別必須観察項目 =====
const DISEASE_ITEMS = {
  '脳梗塞': [
    '麻痺の程度・左右差の変化（上下肢）',
    '構音障害・失語症状の変化',
    '嚥下機能の確認（むせ・誤嚥の有無）',
    '再発の前兆症状（突然の頭痛・めまい・視野異常）',
    '抗凝固薬・抗血小板薬の服薬確認・出血傾向',
    'ADL変化（移動・食事・排泄の自立度）',
    '転倒リスクの評価',
    '認知機能・精神状態の変化',
  ],
  '心不全': [
    '体重の測定（前回比・増減）',
    '呼吸困難・起坐呼吸の有無',
    '下肢浮腫の程度（左右差・圧痕）',
    '頸静脈怒張の有無',
    '肺雑音（水泡音）の聴取',
    '尿量の確認（減少していないか）',
    '利尿剤服薬状況と効果の確認',
    '塩分・水分摂取量の確認',
  ],
  '糖尿病': [
    '血糖値の確認（自己測定記録）',
    '低血糖症状の有無（冷や汗・動悸・ふるえ）',
    'HbA1c・直近の検査値の確認',
    '足の観察（傷・壊疽・変色・爪の状態）',
    'インスリン・内服薬の管理状況',
    'シックデイの有無（発熱・嘔吐・食欲低下）',
    '視力の変化・眼科受診状況',
    '腎機能（浮腫・尿量変化）',
  ],
  'パーキンソン病': [
    '振戦の程度・部位の変化',
    '筋固縮・無動の変化',
    '歩行状態・すくみ足・小刻み歩行の確認',
    '転倒リスク（バランス・姿勢反射）',
    '嚥下機能（むせ・流涎）',
    'L-ドパ服薬時間と効果（ON/OFF現象）',
    'ジスキネジア・副作用症状の有無',
    '便秘の状態（パーキンソン病は便秘になりやすい）',
    '精神症状・幻視・抑うつの有無',
  ],
  'COPD': [
    '呼吸困難の程度（安静時・労作時）',
    '喀痰の量・色・粘稠度の変化',
    '在宅酸素療法の使用状況・流量確認',
    '口すぼめ呼吸・腹式呼吸の実施状況',
    'チアノーゼの有無（口唇・爪）',
    '増悪の兆候（発熱・喀痰増加・呼吸困難増悪）',
    '禁煙状況の確認',
    '吸入薬の使用方法・残量確認',
  ],
  '認知症': [
    '認知機能の変化（見当識・記憶・会話）',
    'BPSD（徘徊・興奮・幻覚・不眠）の有無',
    '食事・水分摂取状況（拒否・忘れ）',
    '服薬管理状況（飲み忘れ・過剰服薬）',
    '転倒・骨折リスクの評価',
    '介護者の疲労・負担感の確認',
    '安全な生活環境の確認（火の扱いなど）',
  ],
  'がん': [
    '疼痛の部位・程度・性状（NRSスケール）',
    '医療用麻薬の効果・副作用の確認',
    '嘔気・嘔吐・食欲不振の程度',
    '倦怠感・全身状態（PS）の変化',
    '呼吸困難の有無',
    '腫瘍浸出液・排液の性状',
    'スピリチュアルペイン・本人の意向確認',
    '家族の介護負担・精神状態の確認',
  ],
  '慢性腎不全': [
    '浮腫の程度（体重増加と合わせて確認）',
    '尿量・尿の色の変化',
    '血圧管理状況',
    '透析患者はシャントの状態確認（雑音・スリル）',
    '食事制限（塩分・カリウム・リン・タンパク質）の遵守状況',
    '皮膚搔痒感の有無',
    '倦怠感・息切れの変化',
  ],
  '褥瘡': [
    '褥瘡の部位・ステージ・サイズの確認',
    '創部の色調（赤・黒・黄・ピンク）',
    '滲出液の量・性状・臭いの確認',
    '周囲皮膚の発赤・硬結・浸軟の有無',
    '体圧分散（体位変換・エアマットの状態）',
    '栄養状態（アルブミン値・食事摂取量）',
    '創処置の実施・使用物品の確認',
  ],
};

// ===== 疾患別観察項目キャッシュ =====
var diseaseItemsCache = {};

// ===== 疾患名から疾患別項目を取得（固定リスト） =====
function getDiseaseItems(diagnosis) {
  const d = diagnosis || '';
  for (const [key, items] of Object.entries(DISEASE_ITEMS)) {
    if (d.includes(key)) return { disease: key, items };
  }
  for (const [key, items] of Object.entries(DISEASE_ITEMS)) {
    const keywords = key === 'がん' ? ['がん', '癌', '腫瘍', '末期'] : [key];
    if (keywords.some(k => d.includes(k))) return { disease: key, items };
  }
  return null;
}

// ===== AI動的生成（固定リストにない疾患用） =====
async function getDiseaseItemsAI(diagnosis) {
  if (!diagnosis) return null;

  // まず固定リストをチェック
  var fixed = getDiseaseItems(diagnosis);
  if (fixed) return fixed;

  // キャッシュチェック
  if (diseaseItemsCache[diagnosis]) return diseaseItemsCache[diagnosis];

  try {
    var result = await callClaude(
      'あなたは経験豊富な訪問看護師です。指定された疾患・病態に対して、訪問看護（在宅の場）で確認すべき観察項目を8〜12個生成してください。医学的観察に加え、日常生活動作（ADL）・生活環境・本人の意向・家族サポート・QOLに関連する在宅ならではの視点も含めてください。JSON形式のみで回答：{"disease":"疾患名（短く）","items":["観察項目1","観察項目2",...]}',
      '疾患名：' + diagnosis,
      true
    );
    var clean = result.replace(/```json|```/g, '').trim();
    var data = JSON.parse(clean);
    // キャッシュに保存
    diseaseItemsCache[diagnosis] = data;
    return data;
  } catch(e) {
    console.error('疾患別観察項目生成エラー:', e);
    return null;
  }
}

// ===== ADL ボタン選択UI =====
var ADL_BASIC_L = ['食事', '更衣', '整容', '口腔ケア', '入浴'];
var ADL_BASIC_R = ['トイレ', '移乗', '移動', '階段'];
var ADL_IADL_L  = ['買い物', '調理'];
var ADL_IADL_R  = ['服薬管理', '金銭管理', '電話操作'];
var ADL_ALL     = ADL_BASIC_L.concat(ADL_BASIC_R, ADL_IADL_L, ADL_IADL_R);

// ボタンの幅定義
var ADL_BTN_WIDTH = {'自立': '4em', '一部介助': '6em', '全介助': '5em'};
// テーマカラー（紺系）
var ADL_SEL_BG   = '#1e3a5f';
var ADL_SEL_TEXT = '#ffffff';

function buildAdlPanel() {
  function makeRows(items, containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = items.map(function(item) {
      var id = 'adlrow-' + item;
      return '<div id="' + id + '" style="display:flex;align-items:center;gap:5px;margin-bottom:7px">' +
        '<span style="min-width:5em;font-size:13px;font-weight:600;color:var(--text-primary);flex-shrink:0">' + item + '</span>' +
        ['自立', '一部介助', '全介助'].map(function(val) {
          return '<button type="button"' +
            ' data-item="' + item + '" data-val="' + val + '"' +
            ' onclick="selectAdl(this)"' +
            ' style="width:' + ADL_BTN_WIDTH[val] + ';white-space:nowrap;font-family:\'Noto Sans JP\',sans-serif;font-size:12px;font-weight:600;padding:4px 0;border-radius:6px;border:1.5px solid #cbd5e1;background:#fff;color:#64748b;cursor:pointer;transition:all 0.15s;flex-shrink:0">' +
            val + '</button>';
        }).join('') +
        '</div>';
    }).join('');
  }
  makeRows(ADL_BASIC_L, 'adl-basic-left');
  makeRows(ADL_BASIC_R, 'adl-basic-right');
  makeRows(ADL_IADL_L,  'adl-iadl-left');
  makeRows(ADL_IADL_R,  'adl-iadl-right');
}

function selectAdl(btn) {
  var item = btn.getAttribute('data-item');
  // 同じ項目の全ボタンをリセット
  document.querySelectorAll('button[data-item="' + item + '"]').forEach(function(b) {
    b.style.background = '#fff';
    b.style.color = '#64748b';
    b.style.borderColor = '#cbd5e1';
  });
  // 選択ボタンをアクティブ化
  btn.style.background = ADL_SEL_BG;
  btn.style.color = ADL_SEL_TEXT;
  btn.style.borderColor = ADL_SEL_BG;
  updateAdlJson();
}

function toggleAdlPanel() {
  var panel = document.getElementById('adl-panel');
  var btn   = document.getElementById('adl-toggle-btn');
  if (!panel) return;
  if (panel.style.display === 'none') {
    if (!document.getElementById('adl-basic-left').children.length) buildAdlPanel();
    panel.style.display = '';
    btn.textContent = 'ADL入力 ▲';
  } else {
    panel.style.display = 'none';
    btn.textContent = 'ADL入力 ▼';
  }
}

function updateAdlJson() {
  var obj = {};
  ADL_ALL.forEach(function(item) {
    var sel = document.querySelector('button[data-item="' + item + '"][style*="' + ADL_SEL_BG + '"]');
    if (sel) obj[item] = sel.getAttribute('data-val');
  });
  var el = document.getElementById('reg-adl');
  if (el) el.value = Object.keys(obj).length ? JSON.stringify(obj) : '';
}

function setAdlFromJson(str) {
  if (!document.getElementById('adl-basic-left').children.length) buildAdlPanel();
  // 全ボタンをリセット
  document.querySelectorAll('button[data-item]').forEach(function(b) {
    b.style.background = '#fff';
    b.style.color = '#64748b';
    b.style.borderColor = '#cbd5e1';
  });
  var el = document.getElementById('reg-adl');
  if (el) el.value = str || '';
  if (!str) return;
  var obj;
  try { obj = JSON.parse(str); } catch(e) { return; }
  ADL_ALL.forEach(function(item) {
    if (obj[item]) {
      var btn = document.querySelector('button[data-item="' + item + '"][data-val="' + obj[item] + '"]');
      if (btn) {
        btn.style.background = ADL_SEL_BG;
        btn.style.color = ADL_SEL_TEXT;
        btn.style.borderColor = ADL_SEL_BG;
      }
    }
  });
}

function adlJsonToText(str) {
  if (!str) return '';
  var obj;
  try { obj = JSON.parse(str); } catch(e) { return str; }
  return Object.keys(obj).map(function(k) { return k + '：' + obj[k]; }).join('、');
}

// 内服薬文字列を配列に変換（改行区切り優先、なければカンマ区切り）
function parseMedicinesList(str) {
  if (!str) return [];
  if (str.indexOf('\n') >= 0) return str.split('\n').filter(Boolean);
  return str.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

// HTML特殊文字エスケープ
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// 内服薬行UIをレンダリング（番号＋入力欄＋×ボタン）
function renderMedicineRows(containerId, medicines) {
  var container = document.getElementById(containerId);
  if (!container) return;
  var list = parseMedicinesList(medicines || '');
  container.innerHTML = list.map(function(med, i) {
    var val = med.replace(/^\d+\.\s*/, ''); // AI出力の先頭番号を除去
    return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px" class="med-row">' +
      '<span style="color:var(--primary);font-weight:700;min-width:20px;font-size:13px;flex-shrink:0">' + (i+1) + '.</span>' +
      '<input type="text" value="' + escHtml(val) + '" placeholder="薬剤名 用量 用法" ' +
      'style="flex:1;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px">' +
      '<button type="button" onclick="removeMedicineRow(this,\'' + containerId + '\')" ' +
      'style="background:none;border:none;color:#ef4444;font-size:18px;line-height:1;cursor:pointer;padding:0 4px;flex-shrink:0">×</button>' +
      '</div>';
  }).join('');
}

// 行番号を再採番
function reindexMedicineRows(containerId) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.med-row').forEach(function(row, i) {
    var num = row.querySelector('span');
    if (num) num.textContent = (i+1) + '.';
  });
}

// 空行を追加
function addMedicineRow(containerId) {
  var container = document.getElementById(containerId);
  if (!container) return;
  var count = container.querySelectorAll('.med-row').length;
  var div = document.createElement('div');
  div.className = 'med-row';
  div.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';
  div.innerHTML =
    '<span style="color:var(--primary);font-weight:700;min-width:20px;font-size:13px;flex-shrink:0">' + (count+1) + '.</span>' +
    '<input type="text" value="" placeholder="薬剤名 用量 用法" ' +
    'style="flex:1;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px">' +
    '<button type="button" onclick="removeMedicineRow(this,\'' + containerId + '\')" ' +
    'style="background:none;border:none;color:#ef4444;font-size:18px;line-height:1;cursor:pointer;padding:0 4px;flex-shrink:0">×</button>';
  container.appendChild(div);
  div.querySelector('input').focus();
}

// 行を削除して再採番
function removeMedicineRow(btn, containerId) {
  var row = btn.closest('.med-row');
  if (row) row.parentNode.removeChild(row);
  reindexMedicineRows(containerId);
}

// 行から内服薬文字列を取得（改行結合）
function getMedicinesFromRows(containerId) {
  var container = document.getElementById(containerId);
  if (!container) return '';
  var lines = [];
  container.querySelectorAll('.med-row input[type="text"]').forEach(function(inp) {
    var v = inp.value.trim();
    if (v) lines.push(v);
  });
  return lines.join('\n');
}

// ===== 患者登録 =====
async function generateObservations() {
  const name = document.getElementById('reg-name').value.trim();
  const age = document.getElementById('reg-age').value;
  const gender = document.getElementById('reg-gender').value;
  const diagnosis = document.getElementById('reg-diagnosis').value.trim();
  const history = document.getElementById('reg-history').value.trim();
  const procedures = document.getElementById('reg-procedures').value.trim();
  const adl = adlJsonToText(document.getElementById('reg-adl').value.trim());
  const notes = document.getElementById('reg-notes').value.trim();

  if (!name) { showStatus('⚠️ 氏名を入力してください'); return; }
  if (!diagnosis) { showStatus('⚠️ 主病名を入力してください'); return; }

  const btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> AIが生成中...';

  try {
    // 疾患別項目を取得
    const diseaseResult = getDiseaseItems(diagnosis);

    // AIに「上記以外で追加すべき項目」だけを生成させる
    const commonList = COMMON_ITEMS.join('\n');
    const diseaseList = diseaseResult ? diseaseResult.items.join('\n') : '';

    const result = await callClaude(
      `あなたは訪問看護の専門家です。
以下の「共通必須項目」と「疾患別必須項目」はすでに観察リストに含まれています。
これらと重複しない、この患者固有の追加観察項目を5〜8項目生成してください。
医療処置・ADL・特記事項の内容を踏まえた具体的な項目にしてください。
形式：箇条書き（・〇〇の確認）のみ。説明文不要。
訪問看護の視点はアセスメントの内容に自然に反映させること。宣言文・前置き・締め文は不要。

【すでに含まれている共通必須項目】
${commonList}

【すでに含まれている疾患別必須項目】
${diseaseList}

【倫理的制約】
・本人が望んでいない生活変容・行動変容を推奨しない
・本人の意思・価値観・生活習慣を否定するような表現を使わない
・「〜すべき」「〜させる必要がある」という一方的な表現を避ける
・家族の希望を本人の意向より優先する示唆をしない
・AIの出力はあくまで看護師の判断を補助するものであり、最終判断は必ず担当看護師が行う`,
      `患者情報：
氏名：${name}（${age}歳・${gender}）
主病名：${diagnosis}
既往歴：${history}
医療処置：${procedures}
ADL：${adl}
特記事項：${notes}`
    );

    const aiItems = result.split('\n').filter(l => l.trim()).map(l => l.replace(/^[・\-\*]\s*/, '').trim()).filter(Boolean);

    // チェックリストを描画
    const checklist = document.getElementById('obs-checklist');
    let html = '';

    // ① 共通必須項目（確定・チェックなし）
    html += `<li class="obs-section-header">🔒 共通必須項目（全患者共通）</li>`;
    COMMON_ITEMS.forEach(item => {
      html += `<li class="checklist-item fixed"><span class="fixed-badge">必須</span><span class="fixed-label">${item}</span></li>`;
    });

    // ② 疾患別必須項目（確定・チェックなし）
    if (diseaseResult) {
      html += `<li class="obs-section-header">🩺 ${diseaseResult.disease}の必須観察項目</li>`;
      diseaseResult.items.forEach(item => {
        html += `<li class="checklist-item fixed disease"><span class="fixed-badge disease">疾患別</span><span class="fixed-label">${item}</span></li>`;
      });
    }

    // ③ AI追加提案項目（チェックボックスあり）
    if (aiItems.length > 0) {
      html += `<li class="obs-section-header">🤖 AI追加提案項目（この患者固有）</li>`;
      aiItems.forEach((obs, i) => {
        html += `
          <li class="checklist-item" id="obs-item-${i}" onclick="toggleCheck(${i})">
            <input type="checkbox" id="obs-${i}" onchange="toggleCheck(${i})" onclick="event.stopPropagation()">
            <label for="obs-${i}">${obs}</label>
          </li>`;
      });
    }

    checklist.innerHTML = html;
    observations = aiItems;

    document.getElementById('obs-card').style.display = '';
    document.getElementById('obs-card').scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch(e) {
    showStatus('⚠️ AIの呼び出しに失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🤖 AIで観察項目を生成';
  }
}

function toggleCheck(i) {
  const cb = document.getElementById('obs-' + i);
  const item = document.getElementById('obs-item-' + i);
  if (event.target !== cb) cb.checked = !cb.checked;
  item.classList.toggle('checked', cb.checked);
}

async function savePatient() {
  const name = document.getElementById('reg-name').value.trim();
  const age = document.getElementById('reg-age').value;
  const gender = document.getElementById('reg-gender').value;
  const diagnosis = document.getElementById('reg-diagnosis').value.trim();
  const history = document.getElementById('reg-history').value.trim();
  const procedures = document.getElementById('reg-procedures').value.trim();
  const adl = document.getElementById('reg-adl').value.trim();
  const notes = document.getElementById('reg-notes').value.trim();

  if (!name) { showStatus('⚠️ 氏名を入力してください'); return; }

  const btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '💾 保存中...';

  try {
    const medicines = getMedicinesFromRows('reg-medicines-rows');
    const nurse = document.getElementById('reg-nurse') ? document.getElementById('reg-nurse').value.trim() : '';
    const livingSituation = document.getElementById('reg-living-situation') ? document.getElementById('reg-living-situation').value.trim() : '';
    const keyPerson = document.getElementById('reg-key-person') ? document.getElementById('reg-key-person').value.trim() : '';
    const emergencyContact = document.getElementById('reg-emergency-contact') ? document.getElementById('reg-emergency-contact').value.trim() : '';
    const caregiverNotes = document.getElementById('reg-caregiver-notes') ? document.getElementById('reg-caregiver-notes').value.trim() : '';
    // 観察項目を収集
    var allObsItems = COMMON_ITEMS.slice();
    var diseaseObsResult = getDiseaseItems(diagnosis);
    if (diseaseObsResult) allObsItems = allObsItems.concat(diseaseObsResult.items);
    if (observations && observations.length) allObsItems = allObsItems.concat(observations);

    const patientPayload = {
      name, age: age ? parseInt(age) : null,
      nurse: nurse || null,
      gender: gender || null,
      main_diagnosis: diagnosis || null,
      medical_history: history || null,
      medical_procedures: procedures || null,
      adl: adl || null,
      notes: notes || null,
      medicines: medicines || null,
      observation_items: allObsItems.length ? allObsItems.join('\n') : null,
      living_situation: livingSituation || null,
      key_person: keyPerson || null,
      emergency_contact: emergencyContact || null,
      caregiver_notes: caregiverNotes || null
    };
    if (window.editingPatientId) {
      await supabaseFetch('patients?id=eq.' + window.editingPatientId, 'PATCH', patientPayload);
      window.editingPatientId = null;
      var saveBtn = document.querySelector('button[onclick="savePatient()"]');
      if (saveBtn) { saveBtn.innerHTML = '💾 この患者を保存する'; saveBtn.style.background = ''; }
    } else {
      await supabaseFetch('patients', 'POST', patientPayload);
    }

    showStatus('✅ 患者情報を保存しました');
    clearRegForm();
    document.getElementById('obs-card').style.display = 'none';
    loadPatients();
    switchTab('patients');

  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '💾 この患者を保存する';
  }
}


// ===== お薬手帳読み取り =====
function readMedicinePhoto() {
  var file = document.getElementById('medicine-photo').files[0];
  if (!file) return;
  document.getElementById('medicine-photo-name').textContent = file.name;
  var reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('medicine-img').src = e.target.result;
    document.getElementById('medicine-preview').style.display = '';
  };
  reader.readAsDataURL(file);
}

async function analyzeMedicinePhoto() {
  var file = document.getElementById('medicine-photo').files[0];
  if (!file) { showStatus('⚠️ 写真を選択してください'); return; }

  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> 読み取り中...';

  try {
    var reader = new FileReader();
    var base64 = await new Promise(function(resolve) {
      reader.onload = function(e) { resolve(e.target.result.split(',')[1]); };
      reader.readAsDataURL(file);
    });

    var mediaType = file.type || 'image/jpeg';

    var response = await fetch('/.netlify/functions/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL_FAST,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 }
            },
            {
              type: 'text',
              text: 'このお薬手帳の画像から内服薬の一覧を読み取ってください。以下の形式で番号付きリストとして出力してください。\n1. 薬剤名 用量 用法\n2. 薬剤名 用量 用法\n（以降同様）\n前置き・後置きの説明は不要です。読み取れない場合のみその旨を伝えてください。'
            }
          ]
        }]
      })
    });

    var data = await response.json();
    var result = data.content[0].text;

    var current = getMedicinesFromRows('reg-medicines-rows');
    renderMedicineRows('reg-medicines-rows', current ? current + '\n' + result : result);
    showStatus('✅ お薬手帳を読み取りました！内容を確認してください');
    document.getElementById('medicine-preview').style.display = 'none';
    document.getElementById('medicine-photo-name').textContent = 'ファイル未選択';

  } catch(e) {
    showStatus('⚠️ 読み取りに失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🤖 AIで読み取る';
  }
}

function clearRegForm() {
  renderMedicineRows('reg-medicines-rows', '');
  ['reg-name','reg-age','reg-gender','reg-nurse','reg-diagnosis','reg-history','reg-procedures','reg-adl','reg-notes','reg-care-level','reg-independence','reg-dementia-level','reg-living-situation','reg-key-person','reg-emergency-contact','reg-caregiver-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // ADLボタンをリセット
  document.querySelectorAll('button[data-item]').forEach(function(b) {
    b.style.background = '#fff';
    b.style.color = '#64748b';
    b.style.borderColor = '#cbd5e1';
  });
  var adlEl = document.getElementById('reg-adl');
  if (adlEl) adlEl.value = '';
  document.getElementById('obs-card').style.display = 'none';
}

// ===== 職種切り替え =====
let currentStaff = 'ns';

function switchStaff(type) {
  currentStaff = type;
  ['ns','pt','ot','st'].forEach(t => {
    document.getElementById('staff-' + t).classList.toggle('active', t === type);
  });
  const isRehab = ['pt','ot','st'].includes(type);
  document.getElementById('form-ns').style.display = isRehab ? 'none' : '';
  document.getElementById('form-rehab').style.display = isRehab ? '' : 'none';
  var rehabPlanBtn = document.getElementById('btn-rehab-plan');
  if (rehabPlanBtn) rehabPlanBtn.style.display = isRehab ? '' : 'none';

  const labels = {
    pt: '実施内容・アプローチ（PT：歩行・筋力・バランス訓練など）',
    ot: '実施内容・アプローチ（OT：上肢機能・ADL・認知訓練など）',
    st: '実施内容・アプローチ（ST：嚥下・構音・言語訓練など）',
  };
  if (isRehab) document.getElementById('rehab-content-label').textContent = labels[type];
}

// ===== 訪問記録 =====
var visitsPage = 0;
var visitsPerPage = 5;
var allVisitsCache = [];

async function loadVisits() {
  if (!currentPatient) return;
  visitsPage = 0;
  var container = document.getElementById('visits-list');
  try {
    allVisitsCache = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&order=visit_date.desc');
    renderVisits();
  } catch(e) {
    container.innerHTML = '<div class="alert alert-error">⚠️ 読み込みエラー: ' + e.message + '</div>';
  }
}

function renderVisits() {
  var container = document.getElementById('visits-list');
  if (!allVisitsCache.length) {
    container.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>まだ記録がありません</p></div>';
    return;
  }
  var end = (visitsPage + 1) * visitsPerPage;
  var shown = allVisitsCache.slice(0, end);
  var hasMore = end < allVisitsCache.length;
  var html = '';
  for (var i = 0; i < shown.length; i++) {
    var v = shown[i];
    var sid = v.id.replace(/'/g, '');
    var sdate = (v.visit_date || '').replace(/'/g, '');
    html += '<div class="visit-card fade-in">';
    html += '<div class="visit-card-header">';
    html += '<div class="visit-date-label">📅 ' + (v.visit_date || '') + '</div>';
    html += '<div style="display:flex;gap:6px">';
    html += '<button class="btn btn-secondary btn-sm" onclick="copyVisitContent(\'' + sid + '\')" title="記録内容をコピー">📋 記録</button>';
    html += '<button class="btn btn-secondary btn-sm" onclick="editVisit(\'' + sid + '\',\'' + sdate + '\',this)">✏️ 編集</button>';
    html += '<button class="btn btn-sm" onclick="deleteVisit(\'' + sid + '\',\'' + sdate + '\')" style="background:#fdf0f0;color:#d94f4f;border:1px solid #f0b0b0;font-size:12px">🗑️ 削除</button>';

    html += '</div></div>';
    if (v.staff_name) html += '<div style="font-size:11px;color:var(--primary);font-weight:700;margin-bottom:6px">👤 ' + v.staff_name + '</div>';
    if (v.content) html += '<p style="font-size:14px;margin-bottom:8px;white-space:pre-wrap">' + v.content + '</p>';
    if (v.observations) {
      var obsId = 'obs-' + sid;
      html += '<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px">' +
        '<p id="' + obsId + '" style="font-size:13px;color:var(--text-secondary);white-space:pre-wrap;margin:0;flex:1">📌 ' + v.observations + '</p>' +
        '<button class="btn btn-secondary btn-sm" style="flex-shrink:0;font-size:11px;padding:3px 8px" onclick="copyObsById(\'' + obsId + '\')">📋</button>' +
        '</div>';
    }
    html += '</div>';
  }
  if (hasMore) {
    html += '<button class="btn btn-secondary btn-full" style="margin-top:10px" onclick="loadMoreVisits()">📄 次の' + visitsPerPage + '件を表示</button>';
  }
  container.innerHTML = html;
}

function loadMoreVisits() {
  visitsPage++;
  renderVisits();
}

async function saveVisit() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  const date = document.getElementById('visit-date').value;
  const obs = document.getElementById('visit-observations').value.trim();
  if (!date) { showStatus('⚠️ 訪問日を入力してください'); return; }

  // 編集モードの場合はUPDATE
  if (window.editingVisitId) {
    const isRehab = ['pt','ot','st'].includes(currentStaff);
    let contentText = isRehab
      ? '【' + {pt:'PT',ot:'OT',st:'ST'}[currentStaff] + '記録】\n実施内容：' + document.getElementById('rehab-content').value.trim()
      : document.getElementById('visit-content').value.trim();
    const btn = event.target;
    btn.disabled = true;
    try {
      await supabaseFetch('visits?id=eq.' + window.editingVisitId, 'PATCH', {
        visit_date: date, content: contentText, observations: obs || null,
        staff_name: currentStaffInfo ? currentStaffInfo.name : null
      });
      window.editingVisitId = null;
      btn.innerHTML = '💾 記録を保存';
      btn.style.background = '';
      document.getElementById('visit-content').value = '';
      document.getElementById('visit-observations').value = '';
      showStatus('✅ 記録を更新しました');
      loadVisits();
    } catch(e) {
      showStatus('⚠️ 更新に失敗しました: ' + e.message, 5000);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  const isRehab = ['pt','ot','st'].includes(currentStaff);
  let contentText = '';

  if (isRehab) {
    const rc = document.getElementById('rehab-content').value.trim();
    const radl = document.getElementById('rehab-adl').value.trim();
    const rgoal = document.getElementById('rehab-goal').value.trim();
    if (!rc) { showStatus('⚠️ 実施内容を入力してください'); return; }
    const staffLabel = {pt:'PT', ot:'OT', st:'ST'}[currentStaff];
    var vtBpH = document.getElementById('vt-bp-h').value;
    var vtBpL = document.getElementById('vt-bp-l').value;
    var vtPulse = document.getElementById('vt-pulse').value;
    var vtTemp = document.getElementById('vt-temp').value;
    var vtSpo2 = document.getElementById('vt-spo2').value;
    var vtResp = document.getElementById('vt-resp').value;
    var vtCons = document.getElementById('vt-consciousness').value;
    var vtHasVal = vtBpH || vtPulse || vtTemp || vtSpo2;
    var vtLine = vtHasVal ? '\n＜バイタル＞\n体温：' + (vtTemp||'') + '　血圧：' + (vtBpH&&vtBpL ? vtBpH+'/'+vtBpL : '') + '　脈拍：' + (vtPulse||'') + '　SpO2：' + (vtSpo2||'') + (vtResp ? '　呼吸数：'+vtResp : '') + '　意識：' + vtCons : '';
    contentText = '【' + staffLabel + '記録】\n実施内容：' + rc + (radl ? '\nADL評価：' + radl : '') + (rgoal ? '\n目標達成度：' + rgoal : '') + vtLine;
  } else {
    contentText = document.getElementById('visit-content').value.trim();

    // バイタルを取得
    var bpH = document.getElementById('vt-bp-h').value;
    var bpL = document.getElementById('vt-bp-l').value;
    var pulse = document.getElementById('vt-pulse').value;
    var temp = document.getElementById('vt-temp').value;
    var spo2 = document.getElementById('vt-spo2').value;
    var resp = document.getElementById('vt-resp').value;
    var cons = document.getElementById('vt-consciousness').value;
    var hasVital = bpH || pulse || temp || spo2;

    // 記録欄が空でもバイタルがあれば保存可能
    if (!contentText && !hasVital) { showStatus('⚠️ 訪問内容またはバイタルを入力してください'); return; }

    if (hasVital && contentText.includes('体温：')) {
      // SOAPテンプレートのバイタル欄に値を埋め込む
      if (temp) contentText = contentText.replace(/体温：\s*/, '体温：' + temp + '　');
      if (bpH && bpL) contentText = contentText.replace(/血圧：\s*/, '血圧：' + bpH + '/' + bpL + '　');
      if (pulse) contentText = contentText.replace(/脈拍：\s*/, '脈拍：' + pulse + '　');
      if (spo2) contentText = contentText.replace(/SpO2：\s*/, 'SpO2：' + spo2 + '　');
      if (resp) contentText = contentText.replace(/呼吸数：\s*/, '呼吸数：' + resp + '　');
      if (cons) contentText = contentText.replace(/意識レベル：\s*/, '意識レベル：' + cons);
    } else if (hasVital) {
      // テンプレートなしの場合は先頭にバイタルを追加
      var vLine = '＜バイタル＞\n体温：' + (temp||'') + '　血圧：' + (bpH&&bpL ? bpH+'/'+bpL : '') + '　脈拍：' + (pulse||'') + '　SpO2：' + (spo2||'') + '　意識：' + cons + '\n\n';
      contentText = vLine + contentText;
    }
  }

  const btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '💾 保存中...';

  try {
    await supabaseFetch('visits', 'POST', {
      patient_id: currentPatient.id,
      visit_date: date,
      content: contentText,
      observations: obs || null,
      staff_name: currentStaffInfo ? currentStaffInfo.name : null
    });
    // フォームクリア
    if (isRehab) {
      document.getElementById('rehab-content').value = '';
      document.getElementById('rehab-adl').value = '';
      document.getElementById('rehab-goal').value = '';
    } else {
      document.getElementById('visit-content').value = '';
    }
    // バイタル欄をクリア
    ['vt-bp-h','vt-bp-l','vt-pulse','vt-temp','vt-spo2','vt-resp'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('vt-consciousness').value = '清明';
    var disp = document.getElementById('vt-consciousness-display'); if(disp) disp.textContent = '清明';
    document.getElementById('visit-observations').value = '';
    showStatus('✅ 記録を保存しました');
    loadVisits();
    // 保存日がスケジュール表示日と一致すれば反映
    if (date === (window.scheduleViewDate || new Date().toISOString().split('T')[0])) loadTodaySchedule();
  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '💾 記録を保存';
  }
}

// ===== 訪問記録編集 =====
async function editVisit(id, date, btn) {
  try {
    // 全記録から該当IDを取得
    var visits = await supabaseFetch('visits?id=eq.' + id);
    if (!visits.length) { showStatus('⚠️ 記録が見つかりません'); return; }
    var v = visits[0];

    // 入力欄に読み込む
    document.getElementById('visit-date').value = v.visit_date;
    document.getElementById('visit-content').value = v.content || '';
    document.getElementById('visit-observations').value = v.observations || '';

    // テキストからバイタルを抽出してバイタル欄にセット
    var text = v.content || '';
    var bpMatch = text.match(/血圧[：:]\s*(\d+)\/(\d+)/);
    var pulseMatch = text.match(/脈拍[：:]\s*(\d+)/);
    var tempMatch = text.match(/体温[：:]\s*([\d.]+)/);
    var spo2Match = text.match(/SpO2[：:]\s*(\d+)/);
    var respMatch = text.match(/呼吸数[：:]\s*(\d+)/);

    if (bpMatch) {
      document.getElementById('vt-bp-h').value = bpMatch[1];
      document.getElementById('vt-bp-l').value = bpMatch[2];
    }
    if (pulseMatch) document.getElementById('vt-pulse').value = pulseMatch[1];
    if (tempMatch) document.getElementById('vt-temp').value = tempMatch[1];
    if (spo2Match) document.getElementById('vt-spo2').value = spo2Match[1];
    if (respMatch) document.getElementById('vt-resp').value = respMatch[1];

    // 編集中のIDを保持
    window.editingVisitId = id;

    // 保存ボタンのテキストを変更
    var saveBtn = document.querySelector('button[onclick="saveVisit()"]');
    if (saveBtn) {
      saveBtn.innerHTML = '💾 記録を更新';
      saveBtn.style.background = 'linear-gradient(135deg, #e8a838 0%, #f5c86a 100%)';
    }

    // 入力欄までスクロール
    document.getElementById('visit-date').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showStatus('✅ 記録を読み込みました。修正して「更新」してください');
  } catch(e) {
    showStatus('⚠️ 読み込みに失敗しました: ' + e.message, 5000);
  }
}

function getVisitCard(id) {
  var cards = document.querySelectorAll('.visit-card');
  var targetCard = null;
  cards.forEach(function(card) {
    var editBtn = card.querySelector('button[onclick*="editVisit"]');
    if (editBtn && editBtn.getAttribute('onclick').includes(id)) {
      targetCard = card;
    }
  });
  return targetCard;
}

function copyToClipboard(text, label) {
  navigator.clipboard.writeText(text).then(function() {
    showStatus('✅ ' + label + 'をコピーしました');
  }).catch(function() {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showStatus('✅ ' + label + 'をコピーしました');
  });
}

function copyMemoById(id) {
  var el = document.getElementById(id);
  if (!el) { showStatus('⚠️ メモが見つかりません'); return; }
  copyToClipboard(el.textContent.trim(), '申し送りメモ');
}

function copyObsById(id) {
  var el = document.getElementById(id);
  if (!el) { showStatus('⚠️ 申し送りが見つかりません'); return; }
  var text = el.textContent.replace('📌', '').trim();
  copyToClipboard(text, '申し送り');
}

function copyVisitContent(id) {
  var card = getVisitCard(id);
  if (!card) { showStatus('⚠️ 記録が見つかりません'); return; }
  var contentEl = card.querySelector('p');
  if (!contentEl) { showStatus('⚠️ 記録内容がありません'); return; }
  copyToClipboard(contentEl.textContent.trim(), '記録内容');
}

function copyVisitObs(id) {
  var card = getVisitCard(id);
  if (!card) { showStatus('⚠️ 記録が見つかりません'); return; }
  var obsEl = card.querySelectorAll('p')[1];
  if (!obsEl) { showStatus('⚠️ 申し送りがありません'); return; }
  copyToClipboard(obsEl.textContent.replace('📌', '').trim(), '申し送り');
}

async function deleteVisit(id, visitDate) {
  if (!confirm('この訪問記録を削除しますか？\n※この操作は取り消せません')) return;
  try {
    await supabaseFetch('visits?id=eq.' + id, 'DELETE');
    showStatus('🗑️ 記録を削除しました');
    loadVisits();
    // 削除した記録の日付がスケジュール表示日と一致すれば反映
    if (visitDate && visitDate === (window.scheduleViewDate || localDateStr())) loadTodaySchedule();
  } catch(e) {
    showStatus('⚠️ 削除に失敗しました: ' + e.message, 5000);
  }
}

// ===== AIアセスメント =====
async function generateAssessment() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }

  const btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> AIが分析中...';

  try {
    const visits = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&order=visit_date.desc&limit=10');
    const visitText = visits.map(function(v) {
      return '【' + v.visit_date + '】\n' + (v.content || '') + (v.observations ? '\n申し送り：' + v.observations : '');
    }).join('\n\n');

    // 今日入力中の記録も取得
    var todayRecord = document.getElementById('visit-content').value.trim();

    var patientInfo = '【患者情報】\n氏名：' + currentPatient.name + '（' + (currentPatient.age||'不明') + '歳・' + (currentPatient.gender||'不明') + '）\n主病名：' + (currentPatient.main_diagnosis||'') + '\n既往歴：' + (currentPatient.medical_history||'') + '\n医療処置：' + (currentPatient.medical_procedures||'') + '\nADL：' + adlJsonToText(currentPatient.adl||'') + '\n内服薬：' + (currentPatient.medicines||'なし') + '\n特記事項：' + (currentPatient.notes||'') + '\n生活状況：' + (currentPatient.living_situation||'') + '\nキーパーソン：' + (currentPatient.key_person||'') + '\n緊急連絡先：' + (currentPatient.emergency_contact||'') + '\n介護者・家族の状況：' + (currentPatient.caregiver_notes||'');

    var userContent = patientInfo +
      (todayRecord ? '\n\n【本日の記録（入力中）】\n' + todayRecord : '') +
      '\n\n【過去の訪問記録（直近10件）】\n' + (visitText || '記録なし');

    const result = await callClaude(
      'あなたは訪問看護師の臨床判断を支援するAIです。\n\n【訪問看護アセスメントの大前提】\n訪問看護の対象者は自分の家で生活している人です。その人には長年の生活習慣・性格・価値観・家族関係があります。アセスメントとは「医療的問題の列挙」ではなく「その人の現状の評価」です。\n\n【出力構成】\n\n■ O情報の校正\nSOAPのO情報のみ、誤字脱字・句読点だけ修正。内容の追加・削除・要約は絶対にしない。S情報は校正しない。\n\n■ 臨床的根拠\n観察事実の臨床的な意味を2〜3点。「〜とされています」「〜の可能性があります」という表現で。在宅生活への影響も含める。\n\n■ アセスメント統合\n看護師がA欄に記載した内容がある場合：その内容を軸に、観察事実・患者背景・本人の言葉を自然に統合して1つのアセスメント文にまとめる。「既存のアセスメントに加えて」のような継ぎ足し表現は使わない。\nA欄の記載がない場合：観察事実・本人の意向・生活背景・残存機能を踏まえた評価を必要な内容が伝わるよう過不足なく書く。\n\n【絶対に守るルール】\n・主語（患者A、患者Aさん）を書かない\n・宣言文・締め文・前置きを書かない\n・本人の意思・価値観・生活習慣を否定しない\n・患者の意向を軸にしながら、家族の思いや介護状況も視野に入れた評価をする。看護師は患者の代弁者であると同時に、家族を含む在宅療養全体を支える存在であることを踏まえる。\n・AIは判断・断定をしない。看護師の思考を補足する支援ツールに徹する\n・1文に複数のテーマを詰め込まない。循環器・創傷・認知機能・生活背景など内容のまとまりごとに文を分ける\n・「〜の中で」「〜も含め」「〜があり」などの接続表現を連続して使わない\n・読み手が状態像を自然に把握できる流れのある文章にする\n・文体は「である調」「体言止め」で統一する。「〜です」「〜ます」などのですます調は使わない\n・症状や問題を1つずつ羅列しない。関連する問題をまとめて1つの段落として書く\n　例：循環器症状と転倒リスクは1段落、創傷・疼痛・ADLは1段落、食事・嚥下・排便は1段落、認知・生活・家族関係は1段落\n・段落間に空白行を入れない。段落は改行なしで続ける\n・各段落は2〜3文でまとめる',
      userContent,
      false,
      0.3
    );

    document.getElementById('assessment-content').textContent = result;
    document.getElementById('assessment-output').style.display = '';
    document.getElementById('assessment-output').scrollIntoView({ behavior: 'smooth' });

    // 【アセスメント統合】部分だけ抽出してSOAPのA欄に挿入
    var aExampleMarker = '■ アセスメント統合';
    var aOnlyText = result;
    if (result.includes(aExampleMarker)) {
      var aExStart = result.indexOf(aExampleMarker) + aExampleMarker.length;
      aOnlyText = result.substring(aExStart).trim();
    }

    var visitContent = document.getElementById('visit-content').value;
    if (visitContent.includes('【A：アセスメント】')) {
      var aMarker = '【A：アセスメント】';
      var pMarker = '【P：プラン】';
      var aStart = visitContent.indexOf(aMarker) + aMarker.length;
      var pStart = visitContent.indexOf(pMarker);
      if (pStart > aStart) {
        var newContent = visitContent.substring(0, aStart) + '\n' + aOnlyText + '\n\n' + visitContent.substring(pStart);
        document.getElementById('visit-content').value = newContent;
        showStatus('✅ アセスメントをSOAPのA欄に挿入しました');
      }
    } else {
      showStatus('✅ アセスメントを生成しました');
    }

    // チャットエリアを表示・初期化
    window.currentAssessment = result;
    window.assessmentChatHistory = [];
    var chatEl = document.getElementById('assessment-chat');
    if (chatEl) {
      chatEl.style.display = '';
      var msgs = document.getElementById('chat-messages');
      msgs.innerHTML = '<div style="background:var(--primary);color:white;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:13px;max-width:85%;line-height:1.6">アセスメントを生成しました。「もっと簡潔に」「浮腫の評価を追加して」など、修正したい内容を入力してください。</div>';
    }
    // 根拠ボタンを表示
    var evBtn = document.getElementById('evidence-btn-area');
    if (evBtn) {
      evBtn.style.display = '';
      document.getElementById('evidence-output').style.display = 'none';
    }

  } catch(e) {
    showStatus('⚠️ AIの呼び出しに失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🤖 AIでアセスメントを生成';
  }
}



// ===== アセスメント根拠・エビデンス =====
async function generateEvidence() {
  var assessment = window.currentAssessment;
  if (!assessment) { showStatus('⚠️ 先にアセスメントを生成してください'); return; }

  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> 調べています...';

  try {
    var patientInfo = currentPatient
      ? '主病名：' + (currentPatient.main_diagnosis||'') + '\n既往歴：' + (currentPatient.medical_history||'')
      : '';

    var result = await callClaude(
      'あなたは看護教育の専門家です。訪問看護師のアセスメント内容をもとに、その医学的・看護学的根拠とエビデンスをわかりやすく説明してください。在宅ケア・その人中心ケア（Person-Centred Care）の視点を踏まえ、以下の形式で出力してください：\n\n【根拠】\n・アセスメントの各ポイントの医学的根拠を箇条書きで3〜5点\n\n【参考ガイドライン・エビデンス】\n・関連するガイドラインや研究知見を2〜3点\n\n【在宅看護のポイント】\n・生活の場での実践・本人の意向や強みの活用・家族支援・QOL維持の観点から、看護師が注意すべき実践的なポイントを2〜3点\n\n専門用語は使いつつも読みやすく。',
      '【アセスメント内容】\n' + assessment + '\n\n【患者情報】\n' + patientInfo
    );

    document.getElementById('evidence-content').textContent = result;
    document.getElementById('evidence-output').style.display = '';
    document.getElementById('evidence-output').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  } catch(e) {
    showStatus('⚠️ 生成に失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📚 このアセスメントの根拠・エビデンスを見る';
  }
}

// ===== アセスメント修正チャット =====
async function sendChatMessage() {
  var input = document.getElementById('chat-input');
  var msg = input.value.trim();
  if (!msg) return;

  var msgs = document.getElementById('chat-messages');
  var btn = document.getElementById('chat-send-btn');

  // ユーザーメッセージを表示
  msgs.innerHTML += '<div style="background:var(--surface2);padding:10px 14px;border-radius:12px 12px 2px 12px;font-size:13px;max-width:85%;align-self:flex-end;margin-left:auto;line-height:1.6">' + msg + '</div>';
  input.value = '';
  btn.disabled = true;
  btn.textContent = '…';
  msgs.scrollTop = msgs.scrollHeight;

  // 会話履歴に追加
  if (!window.assessmentChatHistory) window.assessmentChatHistory = [];
  window.assessmentChatHistory.push({ role: 'user', content: msg });

  try {
    // 現在のSOAP記録を取得
    var visitContent = document.getElementById('visit-content').value;
    var systemPrompt = 'あなたは訪問看護師の記録を支援するAIです。在宅看護・その人中心ケアの視点を大切にし、看護師が書いた内容をリスペクトしながら指示に従って修正・整理してください。断定的な表現は避け「〜の可能性があります」「〜が示唆されます」など支援的な表現を使ってください。エビデンスに基づいた根拠を添えつつ、最終判断は看護師が行うという立場で記載してください。本人の意向・生活背景・残存機能・QOLへの影響も意識した表現を心がけてください。修正後の文章のみを出力してください。';
    var contextMsg = '【現在の訪問記録】\n' + visitContent + '\n\n【現在のアセスメント】\n' + (window.currentAssessment || '');

    // 会話履歴を構築
    var messages = [{ role: 'user', content: contextMsg }, { role: 'assistant', content: '了解しました。修正のご指示をどうぞ。' }];
    window.assessmentChatHistory.forEach(function(m) { messages.push(m); });

    var res = await fetch('/.netlify/functions/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CLAUDE_MODEL_FAST, max_tokens: 1000, system: systemPrompt, messages: messages })
    });
    var data = await res.json();
    var reply = data.content[0].text;

    // 会話履歴に追加
    window.assessmentChatHistory.push({ role: 'assistant', content: reply });
    window.currentAssessment = reply;

    // AIの返答を表示
    msgs.innerHTML += '<div style="background:var(--primary);color:white;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:13px;max-width:85%;line-height:1.6">' + reply + '<br><button onclick="applyAssessment(this)" style="background:rgba(255,255,255,0.2);border:none;color:white;font-size:11px;padding:4px 10px;border-radius:10px;cursor:pointer;margin-top:6px;font-family:inherit">✅ A欄に反映</button></div>';
    msgs.scrollTop = msgs.scrollHeight;

  } catch(e) {
    msgs.innerHTML += '<div style="background:#fdf0f0;color:var(--error);padding:10px 14px;border-radius:12px;font-size:13px;">⚠️ エラー: ' + e.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = '送信';
  }
}

function applyAssessment(btn) {
  var reply = window.currentAssessment;
  if (!reply) return;

  // 【アセスメント統合】部分だけ抽出
  var aExampleMarker = '■ アセスメント統合';
  var aOnlyText = reply;
  if (reply.includes(aExampleMarker)) {
    var aExStart = reply.indexOf(aExampleMarker) + aExampleMarker.length;
    aOnlyText = reply.substring(aExStart).trim();
  }

  var visitContent = document.getElementById('visit-content').value;
  if (visitContent.includes('【A：アセスメント】')) {
    var aMarker = '【A：アセスメント】';
    var pMarker = '【P：プラン】';
    var aStart = visitContent.indexOf(aMarker) + aMarker.length;
    var pStart = visitContent.indexOf(pMarker);
    if (pStart > aStart) {
      document.getElementById('visit-content').value = visitContent.substring(0, aStart) + '\n' + aOnlyText + '\n\n' + visitContent.substring(pStart);
      showStatus('✅ アセスメントをA欄に反映しました');
      return;
    }
  }
  showStatus('✅ アセスメントを更新しました');
}




// ===== 前回の計画書を複写して評価だけ更新 =====
async function copyLastKeikaku() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }

  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> 処理中...';

  try {
    // 保存済み計画書を取得（最新）
    var docs = await supabaseFetch('documents?patient_id=eq.' + currentPatient.id + '&doc_type=eq.keikaku&order=created_at.desc&limit=1');
    if (!docs.length) { showStatus('⚠️ 保存済みの計画書がありません。先に計画書を生成・保存してください'); return; }

    var lastDoc = JSON.parse(docs[0].content);

    // 今月の訪問記録を取得して評価だけAI生成
    var month = new Date().toISOString().slice(0, 7);
    var visits = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&visit_date=gte.' + month + '-01&order=visit_date.asc');
    // 記録が少なければ直近10件
    if (visits.length < 3) {
      visits = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&order=visit_date.desc&limit=10');
    }
    var visitText = visits.map(function(v) {
      return '【' + v.visit_date + '】' + (v.content || '') + (v.observations ? ' 申し送り：' + v.observations : '');
    }).join('\n');

    var newHyoka = await callClaude(
      'あなたは訪問看護師です。訪問記録をもとに、看護計画の評価欄を簡潔に記載してください。箇条書きで3〜5行。「・」で始まる箇条書きのみ出力してください。最後の行は必ず「・プラン継続」と記載してください。\n\n【倫理的制約】\n・本人が望んでいない生活変容・行動変容を推奨しない\n・本人の意思・価値観・生活習慣を否定するような表現を使わない\n・「〜すべき」「〜させる必要がある」という一方的な表現を避ける\n・家族の希望を本人の意向より優先する示唆をしない\n・AIの出力はあくまで看護師の判断を補助するものであり、最終判断は必ず担当看護師が行う',
      '【患者情報】主病名：' + (currentPatient.main_diagnosis||'') + '\n\n【最近の訪問記録】\n' + (visitText||'記録なし'),
      true
    );

    // 前回の内容を複写して評価だけ更新
    var date = document.getElementById('keikaku-date').value;
    var kubun = document.getElementById('keikaku-kubun').value;
    var d = new Date(date || new Date());
    var reiwa = d.getFullYear() - 2018;
    var months = ['01','02','03','04','05','06','07','08','09','10','11','12'];
    var days = ['日','月','火','水','木','金','土'];
    var waDate = '令和' + String(reiwa).padStart(2,'0') + '年' + months[d.getMonth()] + '月' + String(d.getDate()).padStart(2,'0') + '日（' + days[d.getDay()] + '）';

    document.getElementById('keikaku-result').style.display = '';
    document.getElementById('k-date-display').textContent = waDate;
    document.getElementById('k-kubun-display').textContent = kubun;
    document.getElementById('k-mokuhyo').textContent = lastDoc.mokuhyo || '';
    document.getElementById('k-date-col').textContent = waDate;
    document.getElementById('k-content-col').textContent = lastDoc.content || '';
    document.getElementById('k-hyoka-col').textContent = newHyoka;
    document.getElementById('keikaku-result').scrollIntoView({ behavior: 'smooth' });
    showStatus('✅ 前回の計画書を複写し、評価を今月の記録で更新しました');

  } catch(e) {
    showStatus('⚠️ 失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📄 前回を複写して評価更新';
  }
}

// ===== 目標の保存・読み込み =====
async function saveGoal() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  var mokuhyo = document.getElementById('k-mokuhyo').textContent || document.getElementById('k-mokuhyo').innerText;
  if (!mokuhyo.trim()) { showStatus('⚠️ 目標が空です'); return; }

  // 長期・短期目標を分割
  var longGoal = '', shortGoal = '';
  var lines = mokuhyo.split('\n');
  lines.forEach(function(line) {
    if (line.includes('長期目標：')) longGoal = line.replace('長期目標：', '').trim();
    if (line.includes('短期目標：')) shortGoal = line.replace('短期目標：', '').trim();
  });

  try {
    await supabaseFetch('patients?id=eq.' + currentPatient.id, 'PATCH', {
      goal_long: longGoal,
      goal_short: shortGoal
    });
    currentPatient.goal_long = longGoal;
    currentPatient.goal_short = shortGoal;
    showStatus('✅ 目標を患者情報に保存しました！次回から自動で使われます');
  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  }
}



// ===== 前回の計画書を複写して評価だけ更新 =====
async function copyLastKeikaku() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }

  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> 処理中...';

  try {
    // 保存済み計画書を取得（最新）
    var docs = await supabaseFetch('documents?patient_id=eq.' + currentPatient.id + '&doc_type=eq.keikaku&order=created_at.desc&limit=1');
    if (!docs.length) { showStatus('⚠️ 保存済みの計画書がありません。先に計画書を生成・保存してください'); return; }

    var lastDoc = JSON.parse(docs[0].content);

    // 今月の訪問記録を取得して評価だけAI生成
    var month = new Date().toISOString().slice(0, 7);
    var visits = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&visit_date=gte.' + month + '-01&order=visit_date.asc');
    // 記録が少なければ直近10件
    if (visits.length < 3) {
      visits = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&order=visit_date.desc&limit=10');
    }
    var visitText = visits.map(function(v) {
      return '【' + v.visit_date + '】' + (v.content || '') + (v.observations ? ' 申し送り：' + v.observations : '');
    }).join('\n');

    var newHyoka = await callClaude(
      'あなたは訪問看護師です。訪問記録をもとに、看護計画の評価欄を簡潔に記載してください。箇条書きで3〜5行。「・」で始まる箇条書きのみ出力してください。最後の行は必ず「・プラン継続」と記載してください。\n\n【倫理的制約】\n・本人が望んでいない生活変容・行動変容を推奨しない\n・本人の意思・価値観・生活習慣を否定するような表現を使わない\n・「〜すべき」「〜させる必要がある」という一方的な表現を避ける\n・家族の希望を本人の意向より優先する示唆をしない\n・AIの出力はあくまで看護師の判断を補助するものであり、最終判断は必ず担当看護師が行う',
      '【患者情報】主病名：' + (currentPatient.main_diagnosis||'') + '\n\n【最近の訪問記録】\n' + (visitText||'記録なし'),
      true
    );

    // 前回の内容を複写して評価だけ更新
    var date = document.getElementById('keikaku-date').value;
    var kubun = document.getElementById('keikaku-kubun').value;
    var d = new Date(date || new Date());
    var reiwa = d.getFullYear() - 2018;
    var months = ['01','02','03','04','05','06','07','08','09','10','11','12'];
    var days = ['日','月','火','水','木','金','土'];
    var waDate = '令和' + String(reiwa).padStart(2,'0') + '年' + months[d.getMonth()] + '月' + String(d.getDate()).padStart(2,'0') + '日（' + days[d.getDay()] + '）';

    document.getElementById('keikaku-result').style.display = '';
    document.getElementById('k-date-display').textContent = waDate;
    document.getElementById('k-kubun-display').textContent = kubun;
    document.getElementById('k-mokuhyo').textContent = lastDoc.mokuhyo || '';
    document.getElementById('k-date-col').textContent = waDate;
    document.getElementById('k-content-col').textContent = lastDoc.content || '';
    document.getElementById('k-hyoka-col').textContent = newHyoka;
    document.getElementById('keikaku-result').scrollIntoView({ behavior: 'smooth' });
    showStatus('✅ 前回の計画書を複写し、評価を今月の記録で更新しました');

  } catch(e) {
    showStatus('⚠️ 失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📄 前回を複写して評価更新';
  }
}

// ===== 目標の保存・読み込み =====
async function saveGoal() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  var mokuhyo = document.getElementById('k-mokuhyo').textContent || document.getElementById('k-mokuhyo').innerText;
  if (!mokuhyo.trim()) { showStatus('⚠️ 目標が空です'); return; }

  // 長期・短期を分割
  var goalLong = '';
  var goalShort = '';
  var longMatch = mokuhyo.match(/長期目標[：:]\s*(.+?)(?=短期目標|$)/s);
  var shortMatch = mokuhyo.match(/短期目標[：:]\s*(.+?)$/s);
  if (longMatch) goalLong = longMatch[1].trim();
  if (shortMatch) goalShort = shortMatch[1].trim();

  try {
    await supabaseFetch('patients?id=eq.' + currentPatient.id, 'PATCH', {
      goal_long: goalLong || mokuhyo,
      goal_short: goalShort
    });
    currentPatient.goal_long = goalLong || mokuhyo;
    currentPatient.goal_short = goalShort;
    showStatus('✅ 目標を患者情報に保存しました！次回から自動で使用されます');
  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  }
}


// ===== 内服薬編集 =====
function toggleMedicineEdit() {
  // サイドカードの編集エリアを使う
  var area = document.getElementById('medicine-edit-area-side') || document.getElementById('medicine-edit-area');
  if (!area) return;
  var isHidden = area.style.display === 'none';
  area.style.display = isHidden ? '' : 'none';
  if (isHidden && currentPatient) {
    renderMedicineRows('medicine-edit-rows-side', currentPatient.medicines || '');
  }
}

async function saveMedicines() {
  if (!currentPatient) return;
  var medicines = document.getElementById('medicine-edit-input').value.trim();

  try {
    await supabaseFetch('patients?id=eq.' + currentPatient.id, 'PATCH', { medicines: medicines || null });
    currentPatient.medicines = medicines;

    // 表示を更新
    var medHtml = '';
    if (medicines) {
      var medList = medicines.split('\n').filter(Boolean);
      medHtml = '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:6px">💊 内服薬（' + medList.length + '種類）</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:5px">' +
        medList.map(function(med) {
          return '<span style="background:#e8f6fa;border:1px solid #a8d8e8;border-radius:20px;padding:3px 10px;font-size:11px;color:var(--primary)">' + med.trim() + '</span>';
        }).join('') + '</div></div>';
    }

    // サイドの内服薬リストも更新
    var sideList = document.getElementById('medicine-side-list');
    if (sideList) {
      var medList2 = parseMedicinesList(medicines);
      if (medList2.length) {
        sideList.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px">' +
          medList2.map(function(med, i) {
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg);border-radius:6px;font-size:12px">' +
              '<span style="background:var(--primary);color:white;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0">' + (i+1) + '</span>' +
              '<span>' + med.trim() + '</span></div>';
          }).join('') + '</div>';
      } else {
        sideList.innerHTML = '<div style="font-size:13px;color:var(--text-light)">内服薬なし</div>';
      }
      if (document.getElementById('medicine-edit-input-side')) {
        document.getElementById('medicine-edit-input-side').value = medicines || '';
      }
    }

    var info = document.getElementById('selected-patient-info');
    var baseHtml = '<div style="display:flex; align-items:center; gap:12px">' +
      '<div class="patient-avatar" style="width:48px;height:48px;font-size:22px">' +
      (currentPatient.gender === '女性' ? '👩' : currentPatient.gender === '男性' ? '👨' : '🧑') +
      '</div><div>' +
      '<div style="font-size:17px; font-weight:700">' + currentPatient.name + '</div>' +
      '<div style="font-size:13px; color:var(--text-secondary)">' + (currentPatient.age ? currentPatient.age + '歳・' : '') + (currentPatient.gender || '') + (currentPatient.main_diagnosis ? '・' + currentPatient.main_diagnosis : '') + '</div>' +
      '</div></div>';
    info.innerHTML = baseHtml;

    document.getElementById('medicine-edit-area').style.display = 'none';
    showStatus('✅ 内服薬を更新しました');
  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  }
}


async function saveMedicinesSide() {
  if (!currentPatient) return;
  var medicines = getMedicinesFromRows('medicine-edit-rows-side');

  try {
    await supabaseFetch('patients?id=eq.' + currentPatient.id, 'PATCH', { medicines: medicines || null });
    currentPatient.medicines = medicines;

    // サイドリストを更新
    var sideList = document.getElementById('medicine-side-list');
    if (sideList) {
      var medList2 = parseMedicinesList(medicines);
      if (medList2.length) {
        sideList.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px">' +
          medList2.map(function(med, i) {
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg);border-radius:6px;font-size:12px">' +
              '<span style="background:var(--primary);color:white;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0">' + (i+1) + '</span>' +
              '<span>' + med.trim() + '</span></div>';
          }).join('') + '</div>';
      } else {
        sideList.innerHTML = '<div style="font-size:13px;color:var(--text-light)">内服薬なし</div>';
      }
    }

    // 患者カードのタグも更新
    var medHtml = '';
    if (medicines) {
      var medList = medicines.split('\n').filter(Boolean);
      medHtml = '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:6px">💊 内服薬（' + medList.length + '種類）</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:5px">' +
        medList.map(function(med) {
          return '<span style="background:#e8f6fa;border:1px solid #a8d8e8;border-radius:20px;padding:3px 10px;font-size:11px;color:var(--primary)">' + med.trim() + '</span>';
        }).join('') + '</div></div>';
    }
    var info = document.getElementById('selected-patient-info');
    if (info) {
      var baseHtml = '<div style="display:flex; align-items:center; gap:12px">' +
        '<div class="patient-avatar" style="width:48px;height:48px;font-size:22px">' +
        (currentPatient.gender === '女性' ? '👩' : currentPatient.gender === '男性' ? '👨' : '🧑') +
        '</div><div>' +
        '<div style="font-size:17px; font-weight:700">' + currentPatient.name + '</div>' +
        '<div style="font-size:13px; color:var(--text-secondary)">' + (currentPatient.age ? currentPatient.age + '歳・' : '') + (currentPatient.gender || '') + (currentPatient.main_diagnosis ? '・' + currentPatient.main_diagnosis : '') + '</div>' +
        '</div></div>';
      info.innerHTML = baseHtml;
    }

    document.getElementById('medicine-edit-area-side').style.display = 'none';
    showStatus('✅ 内服薬を更新しました');
  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  }
}



// ===== 医師報告文生成 =====
async function generateDoctorReport() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }

  // 現在の記録内容を取得
  var recordContent = document.getElementById('visit-content').value.trim();
  if (!recordContent) { showStatus('⚠️ 記録を入力してください'); return; }

  // バイタルを取得
  var bpH = document.getElementById('vt-bp-h').value;
  var bpL = document.getElementById('vt-bp-l').value;
  var pulse = document.getElementById('vt-pulse').value;
  var temp = document.getElementById('vt-temp').value;
  var spo2 = document.getElementById('vt-spo2').value;
  var cons = document.getElementById('vt-consciousness').value;
  var vitalText = (bpH||pulse||temp||spo2)
    ? '体温' + (temp||'（　）') + '℃、血圧' + (bpH&&bpL ? bpH+'/'+bpL : '（　/　）') + 'mmHg、脈拍' + (pulse||'（　）') + '回/分、SpO2' + (spo2||'（　）') + '%、意識' + cons
    : '体温（　）℃、血圧（　/　）mmHg、脈拍（　）回/分、SpO2（　）%、意識（　）';

  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span>';

  try {
    var patientInfo = currentPatient.name + '様（' + (currentPatient.age||'') + '歳・' + (currentPatient.main_diagnosis||'') + '）';

    var result = await callClaude(
      'あなたは訪問看護師です。訪問記録をもとに、医師への電話報告文を作成してください。' +
      '以下の形式で、電話口でそのまま読み上げられる簡潔な文章にしてください。\n' +
      '「〇〇様の担当看護師の〔名前〕です。本日訪問しましたのでご報告します。\n' +
      'バイタルは〔バイタル〕です。\n' +
      '〔観察所見・状態を2〜3文で〕\n' +
      '〔問題があれば：〇〇の点が気になります。ご指示をお願いします。〕\n' +
      '〔問題なければ：特に変化なく安定しています。以上、報告でした。〕」\n\n' +
      'バイタルは提供された値をそのまま使うこと。緊急性の判断は看護師が行うため、報告文のトーンは中立的に。',
      '【患者】' + patientInfo + '\n【バイタル】' + vitalText + '\n\n【本日の記録】\n' + recordContent,
      true
    );

    document.getElementById('doctor-report-content').textContent = result;
    document.getElementById('doctor-report-area').style.display = '';
    document.getElementById('doctor-report-area').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  } catch(e) {
    showStatus('⚠️ 生成に失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📞 医師報告文';
  }
}














// ===== 患者情報のみ保存（観察項目生成なし） =====
async function savePatientOnly() {
  const name = document.getElementById('reg-name').value.trim();
  if (!name) { showStatus('⚠️ 氏名を入力してください'); return; }

  const btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '💾 保存中...';

  try {
    const age = document.getElementById('reg-age').value;
    const gender = document.getElementById('reg-gender').value;
    const diagnosis = document.getElementById('reg-diagnosis').value.trim();
    const history = document.getElementById('reg-history').value.trim();
    const procedures = document.getElementById('reg-procedures').value.trim();
    const adl = document.getElementById('reg-adl').value.trim();
    const notes = document.getElementById('reg-notes').value.trim();
    const nurse = document.getElementById('reg-nurse') ? document.getElementById('reg-nurse').value.trim() : '';
    const medicines = getMedicinesFromRows('reg-medicines-rows');

    const careLevel2 = document.getElementById('reg-care-level') ? document.getElementById('reg-care-level').value : '';
    const independence2 = document.getElementById('reg-independence') ? document.getElementById('reg-independence').value : '';
    const dementiaLevel2 = document.getElementById('reg-dementia-level') ? document.getElementById('reg-dementia-level').value : '';
    const livingSituation2 = document.getElementById('reg-living-situation') ? document.getElementById('reg-living-situation').value.trim() : '';
    const keyPerson2 = document.getElementById('reg-key-person') ? document.getElementById('reg-key-person').value.trim() : '';
    const emergencyContact2 = document.getElementById('reg-emergency-contact') ? document.getElementById('reg-emergency-contact').value.trim() : '';
    const caregiverNotes2 = document.getElementById('reg-caregiver-notes') ? document.getElementById('reg-caregiver-notes').value.trim() : '';
    const payload = {
      name, age: age ? parseInt(age) : null,
      gender: gender || null,
      nurse: nurse || null,
      main_diagnosis: diagnosis || null,
      medical_history: history || null,
      medical_procedures: procedures || null,
      adl: adl || null,
      notes: notes || null,
      medicines: medicines || null,
      care_level: careLevel2 || null,
      independence_level: independence2 || null,
      dementia_level: dementiaLevel2 || null,
      living_situation: livingSituation2 || null,
      key_person: keyPerson2 || null,
      emergency_contact: emergencyContact2 || null,
      caregiver_notes: caregiverNotes2 || null
    };

    if (window.editingPatientId) {
      await supabaseFetch('patients?id=eq.' + window.editingPatientId, 'PATCH', payload);
      window.editingPatientId = null;
      var saveBtn = document.querySelector('button[onclick="savePatient()"]');
      if (saveBtn) { saveBtn.innerHTML = '💾 この患者を保存する'; saveBtn.style.background = ''; }
    } else {
      await supabaseFetch('patients', 'POST', payload);
    }

    showStatus('✅ 患者情報を保存しました');
    clearRegForm();
    loadPatients();
    switchTab('patients');
  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '💾 保存して終了';
  }
}

// ===== 書類から患者情報読み取り =====
var docFileData = null;
var docFileType = null;

function readDocumentFile(input, type) {
  var file = input.files[0];
  if (!file) return;

  // サイズチェック（PDFは5MB、画像は10MB上限）
  var maxSize = type === 'pdf' ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > maxSize) {
    showStatus('⚠️ ファイルが大きすぎます。PDFは5MB以下、画像は10MB以下にしてください。', 5000);
    return;
  }

  docFileType = type;
  window.docFileMime = file.type || (type === 'pdf' ? 'application/pdf' : 'image/jpeg');

  var reader = new FileReader();
  reader.onload = function(e) {
    docFileData = e.target.result.split(',')[1];
    var preview = document.getElementById('doc-preview');
    var img = document.getElementById('doc-img');
    var filename = document.getElementById('doc-filename');
    preview.style.display = '';
    if (type === 'image') {
      img.src = e.target.result;
      img.style.display = '';
      filename.textContent = file.name;
    } else {
      img.style.display = 'none';
      filename.textContent = '📎 ' + file.name;
    }
  };
  reader.readAsDataURL(file);
}

async function analyzeDocument() {
  if (!docFileData) { showStatus('⚠️ ファイルを選択してください'); return; }

  document.getElementById('doc-reading-status').style.display = '';
  document.getElementById('doc-preview').style.display = 'none';

  try {
    // PDFも画像も同じimage方式で送る（PDFベータAPIはトークン消費が大きいため）
    var imgMediaType = window.docFileMime || (docFileType === 'pdf' ? 'application/pdf' : 'image/jpeg');
    var contentBlock;
    if (docFileType === 'pdf') {
      contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: docFileData } };
    } else {
      // 画像の場合はファイルのmimeタイプを正確に
      contentBlock = { type: 'image', source: { type: 'base64', media_type: imgMediaType, data: docFileData } };
    }

    var response = await fetch('/.netlify/functions/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 600,
        usePdfBeta: docFileType === 'pdf',
        messages: [{
          role: 'user',
          content: [
            contentBlock,
            {
              type: 'text',
              text: '訪問看護指示書の画像から患者情報をJSONで抽出。JSON形式のみで回答。\n【重要な読み取りルール】\n・主たる傷病名は複数ある場合（最大3つ）すべて読み取りカンマ区切りで記載\n・要介護状態区分は○がついている項目を正確に読む（要支援1/要支援2/要介護1/要介護2/要介護3/要介護4/要介護5）\n・障害高齢者の日常生活自立度は□の中に✓またはレ点がある項目（自立/J1/J2/A1/A2/B1/B2/C1/C2）\n・認知症高齢者の日常生活自立度は□の中に✓またはレ点がある項目（自立/Ⅰ/Ⅱa/Ⅱb/Ⅲa/Ⅲb/Ⅳ/M）\n・内服薬は全て1行1薬で薬名・用量・用法を記載\n・医療処置は内服薬を除く処置のみ（点滴・吸引・褥瘡処置・カテーテル等）\n\n{"name":"患者氏名","age":"年齢(数字のみ)","gender":"男性or女性","diagnosis":"主たる傷病名(複数の場合カンマ区切りで全て)","history":"既往歴","procedures":"医療処置(内服薬除く)","adl":"ADL状況","notes":"留意事項・特記事項","medicines":"内服薬全リスト(1行1薬:薬名 用量 用法)","care_level":"要介護度","independence_level":"障害高齢者自立度","dementia_level":"認知症自立度"}。不明は空文字。'
            }
          ]
        }]
      })
    });

    var data = await response.json();

    // APIエラーチェック
    if (!response.ok || data.error) {
      var errMsg = data.error?.message || '';
      if (errMsg.includes('rate limit') || errMsg.includes('tokens per minute')) {
        throw new Error('アクセスが集中しています。少し待ってから再度お試しください（1分後）');
      }
      throw new Error('APIエラー: ' + (errMsg || response.status));
    }
    if (!data.content || !data.content[0] || !data.content[0].text) {
      throw new Error('AIからの応答が空です。PDFが複数ページある場合は、1〜2ページ目だけのPDFにしてから再度お試しください。');
    }

    var result = data.content[0].text;
    var parsed = null;

    // まずJSONとして解析を試みる
    var cleanResult = result.replace(/```json|```/g, '').trim();
    // JSONブロックを探す
    var jsonMatch = cleanResult.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch(e) {}
    }

    // JSON解析失敗時はAIに再度テキスト形式で問い合わせ
    if (!parsed) {
      // テキストから直接フォームに貼り付け
      document.getElementById('reg-notes').value = result;
      showStatus('⚠️ 自動入力できませんでした。「特記事項」欄に読み取り結果を貼り付けました。手動で各項目にコピーしてください。', 6000);
      docFileData = null;
      return;
    }

    // フォームに自動入力
    if (parsed.name) document.getElementById('reg-name').value = parsed.name;
    if (parsed.age) document.getElementById('reg-age').value = String(parsed.age).replace(/[^0-9]/g, '');
    if (parsed.gender) document.getElementById('reg-gender').value = parsed.gender;
    if (parsed.diagnosis) document.getElementById('reg-diagnosis').value = parsed.diagnosis;
    if (parsed.history) document.getElementById('reg-history').value = parsed.history;
    if (parsed.procedures) document.getElementById('reg-procedures').value = parsed.procedures;
    if (parsed.adl) document.getElementById('reg-adl').value = parsed.adl;
    if (parsed.notes) document.getElementById('reg-notes').value = parsed.notes;
    if (parsed.medicines) renderMedicineRows('reg-medicines-rows', parsed.medicines);
    if (parsed.care_level) { var cl = document.getElementById('reg-care-level'); if(cl) cl.value = parsed.care_level; }
    if (parsed.independence_level) { var il = document.getElementById('reg-independence'); if(il) il.value = parsed.independence_level; }
    if (parsed.dementia_level) { var dl = document.getElementById('reg-dementia-level'); if(dl) dl.value = parsed.dementia_level; }

    showStatus('✅ 書類から患者情報を読み取りました！内容を確認してください');
    docFileData = null;

  } catch(e) {
    showStatus('⚠️ 読み取りに失敗しました: ' + e.message, 5000);
  } finally {
    document.getElementById('doc-reading-status').style.display = 'none';
    document.getElementById('doc-preview').style.display = '';
  }
}


// ===== ログイン機能 =====
var currentStaffInfo = null;

async function checkLogin() {
  try {
    var saved = localStorage.getItem('nurseapp_staff');
    if (saved) {
      currentStaffInfo = JSON.parse(saved);
      updateStaffBadge();
      return;
    }
  } catch(e) {}
  // ログイン画面を表示
  document.getElementById('login-screen').style.display = 'flex';
}

function updateStaffBadge() {
  if (!currentStaffInfo) return;
  var badge = document.getElementById('current-staff-badge');
  var roleLabels = { nurse:'看護師', pt:'PT', ot:'OT', st:'ST', admin:'管理者' };
  if (badge) badge.textContent = currentStaffInfo.name + '（' + (roleLabels[currentStaffInfo.role]||currentStaffInfo.role) + '）';
  var adminBtn = document.getElementById('admin-menu-btn');
  if (adminBtn) adminBtn.style.display = currentStaffInfo.role === 'admin' ? '' : 'none';
}

function showRegisterForm() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('register-form').style.display = '';
  document.getElementById('login-error').style.display = 'none';
}

function showLoginForm() {
  document.getElementById('register-form').style.display = 'none';
  document.getElementById('login-form').style.display = '';
  document.getElementById('login-error').style.display = 'none';
}

async function doLogin() {
  var name = document.getElementById('login-name').value.trim();
  var password = document.getElementById('login-password').value;
  if (!name || !password) {
    showLoginError('お名前とパスワードを入力してください');
    return;
  }

  try {
    // パスワードをハッシュ化（簡易）
    var pwHash = btoa(encodeURIComponent(password));
    var staff = await supabaseFetch('staff?name=eq.' + encodeURIComponent(name) + '&password_hash=eq.' + encodeURIComponent(pwHash));
    if (!staff.length) {
      showLoginError('お名前またはパスワードが違います');
      return;
    }
    currentStaffInfo = staff[0];
    try {
      localStorage.setItem('nurseapp_staff', JSON.stringify(currentStaffInfo));
      localStorage.setItem('nurseapp_login_time', Date.now().toString());
    } catch(e) {}
    document.getElementById('login-screen').style.display = 'none';
    updateStaffBadge();
    showStatus('✅ ようこそ、' + currentStaffInfo.name + 'さん');
  } catch(e) {
    showLoginError('ログインに失敗しました: ' + e.message);
  }
}

async function doRegister() {
  var name = document.getElementById('reg-staff-name').value.trim();
  var password = document.getElementById('reg-staff-password').value;
  var role = document.getElementById('reg-staff-role').value;
  if (!name || !password) {
    showLoginError('お名前とパスワードを入力してください');
    return;
  }
  if (password.length < 4) {
    showLoginError('パスワードは4文字以上にしてください');
    return;
  }

  try {
    // 全員招待コード必須（管理者と一般スタッフでコード分け）
    var inviteCode = document.getElementById('admin-invite-code').value;
    var validAdminCode = 'NightKing999';
    var validStaffCode = 'NurseAIDE2025';
    if (role === 'admin' && inviteCode !== validAdminCode) {
      showLoginError('管理者招待コードが違います');
      return;
    }
    if (role !== 'admin' && inviteCode !== validStaffCode && inviteCode !== validAdminCode) {
      showLoginError('招待コードが違います。管理者に確認してください。');
      return;
    }

    var pwHash = btoa(encodeURIComponent(password));
    // 既存チェック
    var existing = await supabaseFetch('staff?name=eq.' + encodeURIComponent(name));
    if (existing.length) {
      showLoginError('このお名前はすでに登録されています');
      return;
    }
    var result = await supabaseFetch('staff', 'POST', {
      name: name,
      email: name + '@nurseapp.local',
      role: role,
      password_hash: pwHash,
      station_name: 'NurseAIDE'
    });
    currentStaffInfo = result[0] || { name, role };
    try {
      localStorage.setItem('nurseapp_staff', JSON.stringify(currentStaffInfo));
      localStorage.setItem('nurseapp_login_time', Date.now().toString());
    } catch(e) {}
    document.getElementById('login-screen').style.display = 'none';
    updateStaffBadge();
    showStatus('✅ 登録完了！ようこそ、' + name + 'さん');
  } catch(e) {
    showLoginError('登録に失敗しました: ' + e.message);
  }
}

function showLoginError(msg) {
  var el = document.getElementById('login-error');
  el.textContent = msg;
  el.style.display = '';
}

function doLogout() {
  if (!confirm('ログアウトしますか？')) return;
  currentStaffInfo = null;
  try { localStorage.removeItem('nurseapp_staff'); } catch(e) {}
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('current-staff-badge').textContent = '';
  showLoginForm();
}


function toggleAdminCode() {
  var role = document.getElementById('reg-staff-role').value;
  // 招待コードは全員必須のため表示切替不要
}



// ===== 管理者パネル =====
function toggleAdminPanel() {
  var panel = document.getElementById('admin-panel');
  var isVisible = panel.style.display !== 'none';
  if (isVisible) {
    panel.style.display = 'none';
  } else {
    panel.style.display = '';
    loadAdminPanel();
  }
}

async function loadAdminPanel() {
  try {
    var staffList = await supabaseFetch('staff?order=created_at.asc');
    var html = '';
    for (var i = 0; i < staffList.length; i++) {
      var s = staffList[i];
      var roleLabel = {nurse:'看護師', pt:'PT', ot:'OT', st:'ST', admin:'管理者'}[s.role] || s.role;
      var isMe = currentStaffInfo && currentStaffInfo.id === s.id;
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--background);border-radius:8px;margin-bottom:6px">';
      html += '<div><span style="font-size:14px;font-weight:700">' + s.name + '</span>';
      html += '<span style="font-size:11px;color:var(--text-secondary);margin-left:8px">' + roleLabel + '</span>';
      if (isMe) html += '<span style="font-size:10px;color:var(--primary);margin-left:6px">（自分）</span>';
      html += '</div>';
      if (!isMe) {
        html += '<button data-sid="' + s.id + '" data-sname="' + s.name.replace(/'/g,"") + '" onclick="deleteStaffBtn(this)" style="font-size:11px;background:none;border:1px solid var(--border);color:var(--text-secondary);padding:3px 8px;border-radius:6px;cursor:pointer">削除</button>';
      }
      html += '</div>';
    }
    document.getElementById('admin-staff-list').innerHTML = html || '<div style="font-size:13px;color:var(--text-secondary)">スタッフが登録されていません</div>';
  } catch(e) {
    document.getElementById('admin-staff-list').innerHTML = '<div style="font-size:13px;color:var(--error)">読み込みエラー</div>';
  }
  try {
    var pats = await supabaseFetch('patients?select=id');
    var vis = await supabaseFetch('visits?select=id');
    document.getElementById('admin-stats').innerHTML = '患者数：<strong>' + pats.length + '名</strong>　訪問記録数：<strong>' + vis.length + '件</strong>';
  } catch(e) {}
}

function deleteStaffBtn(btn) {
  deleteStaff(btn.getAttribute('data-sid'), btn.getAttribute('data-sname'));
}

async function deleteStaff(id, name) {
  if (!confirm(name + 'さんのアカウントを削除しますか？')) return;
  try {
    await supabaseFetch('staff?id=eq.' + id, 'DELETE');
    showStatus('🗑️ ' + name + 'さんのアカウントを削除しました');
    loadAdminPanel();
  } catch(e) {
    showStatus('⚠️ 削除に失敗しました: ' + e.message, 5000);
  }
}

// ===== 自動ログアウト（無操作30分） =====
var autoLogoutTimer = null;
var AUTO_LOGOUT_MS = 30 * 60 * 1000; // 30分

function resetAutoLogoutTimer() {
  if (autoLogoutTimer) clearTimeout(autoLogoutTimer);
  autoLogoutTimer = setTimeout(function() {
    autoSaveAndLogout();
  }, AUTO_LOGOUT_MS);
}

function startAutoLogoutTimer() {
  // ユーザー操作でタイマーリセット
  ['click', 'touchstart', 'keydown', 'scroll'].forEach(function(ev) {
    document.addEventListener(ev, resetAutoLogoutTimer, { passive: true });
  });
  resetAutoLogoutTimer();
}

async function autoSaveAndLogout() {
  // 記録中の内容があれば自動保存
  await autoSaveDraft();
  // ログアウト
  try {
    localStorage.removeItem('nurseapp_staff');
    localStorage.removeItem('nurseapp_login_time');
  } catch(e) {}
  currentStaffInfo = null;
  document.getElementById('login-screen').style.display = 'flex';
  showStatus('⏰ 30分操作がなかったためログアウトしました（記録は自動保存済み）', 6000);
}

// ===== 自動保存（電波切れ・入力中保護） =====
var autoSaveInterval = null;

function startAutoSave() {
  // 30秒ごとに下書き保存
  autoSaveInterval = setInterval(function() {
    saveDraftToLocal();
  }, 30000);

  // オフライン検出
  window.addEventListener('offline', function() {
    saveDraftToLocal();
    showStatus('📡 電波が切れました。入力中の内容は下書き保存しました。', 5000);
  });

  // オンライン復帰
  window.addEventListener('online', function() {
    showStatus('✅ 接続が回復しました', 3000);
    restoreDraftFromLocal();
  });

  // ページ離脱時にも保存
  window.addEventListener('beforeunload', function() {
    saveDraftToLocal();
  });

  // 起動時に下書きを復元
  restoreDraftFromLocal();
}

function saveDraftToLocal() {
  try {
    var content = document.getElementById('visit-content');
    var obs = document.getElementById('visit-observations');
    var date = document.getElementById('visit-date');
    if (!content) return;
    var draft = {
      content: content.value,
      observations: obs ? obs.value : '',
      date: date ? date.value : '',
      patientId: currentPatient ? currentPatient.id : null,
      savedAt: Date.now()
    };
    // 何か入力があれば保存
    if (draft.content || draft.observations) {
      localStorage.setItem('nurseapp_draft', JSON.stringify(draft));
    }
  } catch(e) {}
}

async function autoSaveDraft() {
  // 記録内容があればSupabaseに保存してからログアウト
  try {
    var contentEl = document.getElementById('visit-content');
    var obsEl = document.getElementById('visit-observations');
    var dateEl = document.getElementById('visit-date');
    if (!currentPatient || !contentEl || !contentEl.value.trim()) return;
    var date = dateEl ? dateEl.value : new Date().toISOString().split('T')[0];
    if (!date) date = new Date().toISOString().split('T')[0];
    await supabaseFetch('visits', 'POST', {
      patient_id: currentPatient.id,
      visit_date: date,
      content: contentEl.value.trim(),
      observations: obsEl ? obsEl.value.trim() : null,
      staff_name: currentStaffInfo ? currentStaffInfo.name : null
    });
    // 保存成功したらlocalStorageの下書きも削除
    try { localStorage.removeItem('nurseapp_draft'); } catch(e) {}
  } catch(e) {
    // Supabaseに保存できなくてもlocalStorageには残る
    saveDraftToLocal();
  }
}

function restoreDraftFromLocal() {
  try {
    var draftStr = localStorage.getItem('nurseapp_draft');
    if (!draftStr) return;
    var draft = JSON.parse(draftStr);
    // 24時間以内の下書きのみ復元
    if (!draft.savedAt || (Date.now() - draft.savedAt) > 24 * 60 * 60 * 1000) {
      localStorage.removeItem('nurseapp_draft');
      return;
    }
    // 記録欄が空のときだけ復元、かつ同じ患者のときだけ
    var contentEl = document.getElementById('visit-content');
    if (draft.patientId && currentPatient && draft.patientId !== currentPatient.id) {
      localStorage.removeItem('nurseapp_draft');
      return;
    }
    if (contentEl && !contentEl.value && draft.content) {
      contentEl.value = draft.content;
      var obsEl = document.getElementById('visit-observations');
      if (obsEl && draft.observations) obsEl.value = draft.observations;
      var dateEl = document.getElementById('visit-date');
      if (dateEl && draft.date) dateEl.value = draft.date;
      showStatus('📝 前回の下書きを復元しました', 4000);
    }
  } catch(e) {}
}

// ===== 初回同意 =====
function checkConsent() {
  try {
    var agreed = localStorage.getItem('nurseapp_consent');
    if (agreed) return;
  } catch(e) {}
  document.getElementById('consent-modal').style.display = 'flex';
}

function updateConsentBtn() {
  var terms = document.getElementById('consent-terms').checked;
  var privacy = document.getElementById('consent-privacy').checked;
  var btn = document.getElementById('consent-btn');
  var ok = terms && privacy;
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '0.5';
  btn.style.cursor = ok ? 'pointer' : 'not-allowed';
}

function agreeConsent() {
  try {
    localStorage.setItem('nurseapp_consent', '1');
    var learning = document.getElementById('consent-learning');
    localStorage.setItem('nurseapp_learning_consent', learning && learning.checked ? '1' : '0');
  } catch(e) {}
  document.getElementById('consent-modal').style.display = 'none';
}

// ===== 利用規約・プライバシーポリシー =====
function showTerms() {
  document.getElementById('terms-modal').style.display = '';
}
function showPrivacy() {
  document.getElementById('privacy-modal').style.display = '';
}

// ===== フィードバック =====
var currentRating = 0;
var ratingLabels = ['', '改善が必要', 'もう少し', '普通', '良い', '最高！'];

function setRating(val) {
  currentRating = val;
  document.querySelectorAll('.star').forEach(function(s) {
    s.style.opacity = parseInt(s.getAttribute('data-val')) <= val ? '1' : '0.3';
    s.style.color = parseInt(s.getAttribute('data-val')) <= val ? '#f5a623' : '';
  });
  document.getElementById('rating-label').textContent = ratingLabels[val];
}

async function submitFeedback() {
  if (!currentRating) { showStatus('⚠️ 星をタップして評価してください'); return; }
  var comment = document.getElementById('fb-comment').value.trim();
  var station = document.getElementById('fb-station').value.trim();
  if (!comment) { showStatus('⚠️ コメントを入力してください'); return; }

  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '送信中...';

  try {
    await supabaseFetch('feedback', 'POST', {
      rating: currentRating,
      comment: comment,
      station_name: station || null
    });
    document.getElementById('fb-comment').value = '';
    document.getElementById('fb-station').value = '';
    setRating(0);
    currentRating = 0;
    showStatus('✅ フィードバックを送信しました！ありがとうございます');
    loadFeedback();
  } catch(e) {
    showStatus('⚠️ 送信に失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '📨 フィードバックを送信';
  }
}

async function loadFeedback() {
  var list = document.getElementById('feedback-list');
  if (!list) return;
  try {
    var items = await supabaseFetch('feedback?order=created_at.desc&limit=20');
    if (!items.length) {
      list.innerHTML = '<div class="empty-state"><div class="icon">💬</div><p>まだフィードバックがありません</p></div>';
      return;
    }
    var avgRating = items.reduce(function(sum, f) { return sum + (f.rating||0); }, 0) / items.length;
    list.innerHTML = '<div style="text-align:center;padding:12px;background:var(--bg);border-radius:8px;margin-bottom:12px">' +
      '<div style="font-size:28px;font-weight:700;color:var(--primary)">' + avgRating.toFixed(1) + '</div>' +
      '<div style="color:#f5a623;font-size:18px">' + '★'.repeat(Math.round(avgRating)) + '☆'.repeat(5-Math.round(avgRating)) + '</div>' +
      '<div style="font-size:12px;color:var(--text-secondary)">' + items.length + '件のフィードバック</div>' +
      '</div>' +
      items.map(function(f) {
        var stars = '★'.repeat(f.rating||0) + '☆'.repeat(5-(f.rating||0));
        var date = f.created_at ? f.created_at.slice(0,10) : '';
        return '<div style="padding:12px 0;border-bottom:1px solid var(--border)">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
          '<span style="color:#f5a623;font-size:14px">' + stars + '</span>' +
          '<span style="font-size:11px;color:var(--text-secondary)">' + (f.station_name ? f.station_name + ' · ' : '') + date + '</span>' +
          '</div>' +
          '<div style="font-size:13px;line-height:1.6">' + f.comment + '</div>' +
          '</div>';
      }).join('');
  } catch(e) {
    list.innerHTML = '<div style="font-size:12px;color:var(--error)">読み込みエラー</div>';
  }
}

// ===== 一括書類 =====
async function loadBulkPatientsList(type) {
  var listId = type === 'keikaku' ? 'bulk-keikaku-patient-list' : 'bulk-hokoku-patient-list';
  var list = document.getElementById(listId);
  if (!list) return;
  try {
    var patients = await supabaseFetch('patients?order=name.asc');
    list.innerHTML = patients.map(function(p) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 8px;border-bottom:1px solid var(--border)">' +
        '<span style="font-size:13px;font-weight:700">' + p.name + '</span>' +
        '<input type="checkbox" data-id="' + p.id + '" data-name="' + p.name + '" checked style="width:18px;height:18px;cursor:pointer">' +
        '</div>';
    }).join('');
  } catch(e) { console.error(e); }
}

function bulkSelectAll(type, checked) {
  var listId = type === 'keikaku' ? 'bulk-keikaku-patient-list' : 'bulk-hokoku-patient-list';
  document.querySelectorAll('#' + listId + ' input[type=checkbox]').forEach(function(cb) {
    cb.checked = checked;
  });
}

async function generateBulkDocs(docType) {
  var listId = docType === 'keikaku' ? 'bulk-keikaku-patient-list' : 'bulk-hokoku-patient-list';
  var resultsId = docType === 'keikaku' ? 'bulk-keikaku-results' : 'bulk-hokoku-results';
  var checks = document.querySelectorAll('#' + listId + ' input[type=checkbox]:checked');
  if (!checks.length) { showStatus('⚠️ 患者を選択してください'); return; }

  var month = docType === 'hokoku' ? (document.getElementById('bulk-month') ? document.getElementById('bulk-month').value : '') : '';
  if (docType === 'hokoku' && !month) { showStatus('⚠️ 対象年月を選択してください'); return; }

  var results = document.getElementById(resultsId);
  var patients = Array.from(checks).map(function(cb) {
    return { id: cb.getAttribute('data-id'), name: cb.getAttribute('data-name') };
  });

  var completed = 0;
  var htmlResults = [];

  for (var i = 0; i < patients.length; i++) {
    var p = patients[i];
    results.innerHTML = '<div class="card" style="text-align:center;padding:20px"><span class="loading-dot"><span></span><span></span><span></span></span><br><br>' + p.name + 'さんを処理中... (' + (i+1) + '/' + patients.length + ')</div>';
    try {
      var patientData = await supabaseFetch('patients?id=eq.' + p.id);
      var patient = patientData[0];
      var visits;
      if (docType === 'hokoku') {
        visits = await supabaseFetch('visits?patient_id=eq.' + p.id + '&visit_date=gte.' + month + '-01&visit_date=lte.' + month + '-31&order=visit_date.asc');
      } else {
        visits = await supabaseFetch('visits?patient_id=eq.' + p.id + '&order=visit_date.desc&limit=10');
      }
      var visitText = visits.map(function(v) { return '【' + v.visit_date + '】' + (v.content||''); }).join('\n');
      var patientInfo = '患者：' + patient.name + '（' + (patient.age||'') + '歳）主病名：' + (patient.main_diagnosis||'') + '\n訪問記録：\n' + (visitText||'記録なし');
      var result = await callClaude(
        docType === 'hokoku'
          ? 'あなたは訪問看護師です。訪問看護報告書をJSON形式で作成してください。{"vital":"月間バイタルの範囲","keika":"【看護職員】\n・病状経過（バイタル数値不要）"}\n\n【倫理的制約】\n・本人が望んでいない生活変容・行動変容を推奨しない\n・本人の意思・価値観・生活習慣を否定するような表現を使わない\n・「〜すべき」「〜させる必要がある」という一方的な表現を避ける\n・家族の希望を本人の意向より優先する示唆をしない\n・AIの出力はあくまで看護師の判断を補助するものであり、最終判断は必ず担当看護師が行う'
          : 'あなたは訪問看護師です。訪問看護計画書をJSON形式で作成してください。療養上の問題は#1/#2とナンバリングし、【O-P】観察計画【T-P】ケア計画【E-P】教育計画の3つに分けて記載。長期目標・短期目標・日々の記録に紐づいた具体的な内容で。JSON形式のみ：{"mokuhyo_long":"' + (patient.goal_long||'長期目標') + '","mokuhyo_short":"' + (patient.goal_short||'短期目標') + '","content":"#1 問題名\\n【O-P】\\n・観察項目\\n【T-P】\\n・ケア項目\\n【E-P】\\n・教育項目","hyoka":"評価内容・プラン継続"}\n\n【倫理的制約】\n・本人が望んでいない生活変容・行動変容を推奨しない\n・本人の意思・価値観・生活習慣を否定するような表現を使わない\n・「〜すべき」「〜させる必要がある」という一方的な表現を避ける\n・家族の希望を本人の意向より優先する示唆をしない\n・AIの出力はあくまで看護師の判断を補助するものであり、最終判断は必ず担当看護師が行う',
        patientInfo
      );
      var data;
      try { data = JSON.parse(result.replace(/```json|```/g,'')); } catch(e) { data = docType === 'hokoku' ? {vital:'',keika:result} : {mokuhyo_long:'',mokuhyo_short:'',mondai:'',kansatsu:'',jisshi:'',shido:'',hyoka:''}; }
      htmlResults.push(docType === 'hokoku' ? createHokokuCard(patient, month, data) : createKeikakuCard(patient, data));
      completed++;
    } catch(e) {
      htmlResults.push('<div class="card" style="border-color:var(--error)"><div style="color:var(--error);font-weight:700">' + p.name + ' - エラー</div><div style="font-size:12px">' + e.message + '</div></div>');
    }
  }
  results.innerHTML = '<div style="margin-bottom:10px;font-size:13px;color:var(--text-secondary)">' + completed + '/' + patients.length + '件生成完了</div>' + htmlResults.join('');
  showStatus('✅ ' + completed + '件生成しました');
}


// ===== 一括評価生成 =====
async function generateBulkHyoka() {
  var month = document.getElementById('bulk-hyoka-month').value;
  var reportDate = document.getElementById('bulk-keikaku-date').value;
  if (!month) { showStatus('⚠️ 評価対象月を選択してください'); return; }
  if (!reportDate) { showStatus('⚠️ 新計画書の報告日を入力してください'); return; }

  var checks = document.querySelectorAll('#bulk-keikaku-patient-list input[type=checkbox]:checked');
  if (!checks.length) { showStatus('⚠️ 患者を選択してください'); return; }

  var results = document.getElementById('bulk-keikaku-results');
  var patients = Array.from(checks).map(function(cb) {
    return { id: cb.getAttribute('data-id'), name: cb.getAttribute('data-name') };
  });

  var htmlResults = [];
  var completed = 0;

  for (var i = 0; i < patients.length; i++) {
    var p = patients[i];
    results.innerHTML = '<div class="card" style="text-align:center;padding:20px"><span class="loading-dot"><span></span><span></span><span></span></span><br><br>' + p.name + 'さんの評価を生成中... (' + (i+1) + '/' + patients.length + ')</div>';

    try {
      // 患者情報取得
      var patientData = await supabaseFetch('patients?id=eq.' + p.id);
      var patient = patientData[0];

      // 前回保存済み計画書を取得
      var docs = await supabaseFetch('documents?patient_id=eq.' + p.id + '&doc_type=eq.keikaku&order=created_at.desc&limit=1');
      if (!docs.length) {
        htmlResults.push('<div class="card" style="border-color:var(--error)"><div style="font-weight:700">' + p.name + '</div><div style="font-size:12px;color:var(--error)">保存済み計画書がありません。先に計画書を生成・保存してください。</div></div>');
        continue;
      }
      var lastDoc = JSON.parse(docs[0].content);

      // 対象月の訪問記録を取得
      var nextMonth = month.split('-');
      var y = parseInt(nextMonth[0]), m = parseInt(nextMonth[1]);
      if (m === 12) { y++; m = 1; } else { m++; }
      var nextMonthStr = y + '-' + String(m).padStart(2,'0');
      var visits = await supabaseFetch('visits?patient_id=eq.' + p.id + '&visit_date=gte.' + month + '-01&visit_date=lt.' + nextMonthStr + '-01&order=visit_date.asc');

      if (!visits.length) {
        // 記録がなければ直近10件
        visits = await supabaseFetch('visits?patient_id=eq.' + p.id + '&order=visit_date.desc&limit=10');
      }
      var visitText = visits.map(function(v) {
        return '【' + v.visit_date + '】' + (v.content || '');
      }).join('\n\n');

      // AIで評価だけ生成
      var hyoka = await callClaude(
        'あなたは訪問看護師です。前回の計画書と訪問記録をもとに計画書の評価欄を記載してください。箇条書き3〜5行・「・」で始める・各問題の目標に対して具体的に評価・最後は必ず「・プラン継続」で終わる・評価テキストのみ出力\n\n【倫理的制約】\n・本人が望んでいない生活変容・行動変容を推奨しない\n・本人の意思・価値観・生活習慣を否定するような表現を使わない\n・「〜すべき」「〜させる必要がある」という一方的な表現を避ける\n・家族の希望を本人の意向より優先する示唆をしない\n・AIの出力はあくまで看護師の判断を補助するものであり、最終判断は必ず担当看護師が行う',
        '【患者情報】\n氏名：' + patient.name + '（' + (patient.age||'') + '歳）\n主病名：' + (patient.main_diagnosis||'') + '\n\n【前回計画書の目標】\n長期目標：' + (lastDoc.mokuhyo||lastDoc.mokuhyo_long||'') + '\n短期目標：' + (lastDoc.mokuhyo_short||'') + '\n\n【前回計画書の療養上の課題】\n' + (lastDoc.content||lastDoc.mondai||'') + '\n\n【' + month + 'の訪問記録】\n' + (visitText||'記録なし'),
        true
      );
      // 報告日を令和形式に変換
      var d = new Date(reportDate);
      var reiwa = d.getFullYear() - 2018;
      var months = ['01','02','03','04','05','06','07','08','09','10','11','12'];
      var days = ['日','月','火','水','木','金','土'];
      var waDate = '令和' + String(reiwa).padStart(2,'0') + '年' + months[d.getMonth()] + '月' + String(d.getDate()).padStart(2,'0') + '日（' + days[d.getDay()] + '）';
      var kubun = lastDoc.kubun || '訪問看護（介護）';

      // カード表示
      htmlResults.push(createHyokaCard(patient, waDate, kubun, lastDoc, hyoka, month));
      completed++;

    } catch(e) {
      htmlResults.push('<div class="card" style="border-color:var(--error)"><div style="font-weight:700">' + p.name + ' - エラー</div><div style="font-size:12px">' + e.message + '</div></div>');
    }
  }

  results.innerHTML = '<div style="margin-bottom:10px;font-size:13px;color:var(--text-secondary)">' + completed + '/' + patients.length + '件生成完了</div>' + htmlResults.join('');
  showStatus('✅ ' + completed + '件の評価を生成しました');
}

function createHyokaCard(patient, waDate, kubun, lastDoc, hyoka, month) {
  return '<div class="card" style="margin-bottom:12px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
    '<div>' +
    '<div style="font-weight:700;font-size:15px">' + patient.name + '</div>' +
    '<div style="font-size:11px;color:var(--text-secondary)">' + (patient.main_diagnosis||'') + '　' + waDate + '</div>' +
    '</div>' +
    '<button class="btn btn-secondary btn-sm copy-hyoka-btn" data-patient-id="' + patient.id + '" style="background:#e8f5e9;border-color:#2e7d32;color:#2e7d32">📋 評価をコピー</button>' +
    '</div>' +
    '<div style="background:#f0fff4;border:1px solid #c8e6c9;border-radius:8px;padding:14px">' +
    '<div style="font-size:11px;font-weight:700;color:#2e7d32;margin-bottom:8px">評価（' + month + '）</div>' +
    '<div id="hyoka-' + patient.id + '" contenteditable="true" style="font-size:13px;line-height:1.9;white-space:pre-wrap;outline:none;cursor:text;min-height:60px">' + hyoka + '</div>' +
    '</div>' +
    '</div>';
}


// ===== 一括書類カード生成 =====
function createHokokuCard(patient, month, data) {
  var vital = data.vital || '';
  var keika = data.keika || '';
  return '<div class="card" style="margin-bottom:16px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
    '<div style="font-weight:700;font-size:15px">' + patient.name + '</div>' +
    '<div style="font-size:12px;color:var(--text-secondary)">' + (patient.main_diagnosis||'') + '</div>' +
    '</div>' +
    '<div style="border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden">' +
    '<div style="background:var(--primary-dark);color:white;padding:8px 12px;font-size:13px;font-weight:700">訪問看護報告書　' + month + '</div>' +
    '<div style="display:flex;border-bottom:1px solid var(--border)">' +
    '<div style="padding:8px 12px;font-weight:700;font-size:12px;background:#e8eef5;border-right:1px solid var(--border);min-width:70px">バイタル</div>' +
    '<div style="padding:8px 12px;font-size:12px;line-height:1.7">' + vital + '</div>' +
    '</div>' +
    '<div>' +
    '<div style="padding:6px 12px;font-weight:700;font-size:12px;background:#e8eef5">病状の経過</div>' +
    '<div style="padding:10px 12px;font-size:12px;line-height:1.8;white-space:pre-wrap">' + keika + '</div>' +
    '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-top:8px">' +
    '<button class="btn btn-secondary btn-sm" onclick="copyCardText(this.parentElement.parentElement)">📋 全体コピー</button>' +
    '</div>' +
    '</div>';
}

function createKeikakuCard(patient, data) {
  var mokuhyoLong = data.mokuhyo_long || '';
  var mokuhyoShort = data.mokuhyo_short || '';
  var mondai = data.mondai || '';
  var kansatsu = data.kansatsu || '';
  var jisshi = data.jisshi || '';
  var shido = data.shido || '';
  var hyoka = data.hyoka || '';
  return '<div class="card" style="margin-bottom:16px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
    '<div style="font-weight:700;font-size:15px">' + patient.name + '</div>' +
    '<div style="font-size:12px;color:var(--text-secondary)">' + (patient.main_diagnosis||'') + '</div>' +
    '</div>' +
    '<div style="border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden">' +
    '<div style="background:var(--primary-dark);color:white;padding:8px 12px;font-size:13px;font-weight:700">訪問看護計画書</div>' +
    '<div style="padding:10px 12px;border-bottom:1px solid var(--border)">' +
    '<div style="font-weight:700;font-size:12px;margin-bottom:4px">看護・リハビリテーションの目標</div>' +
    '<div style="font-size:12px;line-height:1.8">長期目標：' + mokuhyoLong + '<br>短期目標：' + mokuhyoShort + '</div>' +
    '</div>' +
    '<div style="padding:10px 12px;border-bottom:1px solid var(--border)">' +
    '<div style="font-weight:700;font-size:12px;margin-bottom:4px">療養上の問題・支援内容</div>' +
    '<div style="font-size:12px;line-height:1.8;white-space:pre-wrap">' + mondai + '</div>' +
    '</div>' +
    '<div style="padding:10px 12px">' +
    '<div style="font-weight:700;font-size:12px;margin-bottom:4px">評価</div>' +
    '<div style="font-size:12px;line-height:1.8;white-space:pre-wrap">' + hyoka + '</div>' +
    '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-top:8px">' +
    '<button class="btn btn-secondary btn-sm" onclick="copyCardText(this.parentElement.parentElement)">📋 全体コピー</button>' +
    '</div>' +
    '</div>';
}

function copyAssessmentSection(section) {
  var fullText = document.getElementById('assessment-content').textContent || '';
  if (!fullText) { showStatus('⚠️ 先にアセスメントを生成してください'); return; }

  var visitContent = document.getElementById('visit-content').value;
  var extracted = '';

  if (section === 'O') {
    // 「記録の整理」セクションを抽出
    var marker = '【記録の校正】';
    var nextMarker = '【判断を支援する根拠】';
    var start = fullText.indexOf(marker);
    var end = fullText.indexOf(nextMarker);
    if (start >= 0) {
      extracted = fullText.substring(start + marker.length, end > start ? end : undefined).trim();
    } else {
      showStatus('⚠️「記録の整理」セクションが見つかりません'); return;
    }

    // O欄のマーカーを複数パターンで検索
    var oPatterns = ['【O：客観的情報】', 'O）', 'O)', 'O：', '〇）', '○）'];
    var aPatterns = ['【A：アセスメント】', 'A）', 'A)', 'A：'];
    var oMarkerFound = '', oStart = -1;
    for (var i = 0; i < oPatterns.length; i++) {
      var idx = visitContent.indexOf(oPatterns[i]);
      if (idx >= 0) { oMarkerFound = oPatterns[i]; oStart = idx + oPatterns[i].length; break; }
    }
    var aMarkerFound = '', aStart = -1;
    for (var j = 0; j < aPatterns.length; j++) {
      var idx2 = visitContent.indexOf(aPatterns[j]);
      if (idx2 >= 0) { aMarkerFound = aPatterns[j]; aStart = idx2; break; }
    }
    if (oStart >= 0 && aStart > oStart) {
      var newContent = visitContent.substring(0, oStart) + '\n' + extracted + '\n' + visitContent.substring(aStart);
      document.getElementById('visit-content').value = newContent;
      showStatus('✅ 記録の整理をO欄に挿入しました');
      return;
    }
    // マーカーが見つからない場合はクリップボード
    navigator.clipboard.writeText(extracted).then(function() { showStatus('✅ 記録の整理をコピーしました（O欄が見つからないためクリップボードへ）'); });

  } else if (section === 'A') {
    // 「アセスメント統合」セクションを抽出
    var aExampleMarker = '■ アセスメント統合';
    var start2 = fullText.indexOf(aExampleMarker);
    if (start2 >= 0) {
      extracted = fullText.substring(start2 + aExampleMarker.length).trim();
      extracted = extracted.replace(/※判断・表現は担当看護師が行ってください[。]*/g, '').trim();
    } else {
      showStatus('⚠️「アセスメント統合」セクションが見つかりません'); return;
    }

    // A欄のマーカーを複数パターンで検索
    var aPatterns2 = ['【A：アセスメント】', 'A）', 'A)', 'A：'];
    var pPatterns = ['【P：プラン】', 'P）', 'P)', 'P：'];
    var aStart2 = -1, aMarker2 = '';
    for (var k = 0; k < aPatterns2.length; k++) {
      var idx3 = visitContent.indexOf(aPatterns2[k]);
      if (idx3 >= 0) { aMarker2 = aPatterns2[k]; aStart2 = idx3 + aPatterns2[k].length; break; }
    }
    var pStart = -1;
    for (var l = 0; l < pPatterns.length; l++) {
      var idx4 = visitContent.indexOf(pPatterns[l]);
      if (idx4 >= 0) { pStart = idx4; break; }
    }
    if (aStart2 >= 0 && pStart > aStart2) {
      var newContent2 = visitContent.substring(0, aStart2) + '\n' + extracted + '\n' + visitContent.substring(pStart);
      document.getElementById('visit-content').value = newContent2;
      showStatus('✅ アセスメント統合をA欄に挿入しました');
      return;
    } else if (aStart2 >= 0) {
      // Pがない場合はAの後に追記
      var newContent3 = visitContent.substring(0, aStart2) + '\n' + extracted;
      document.getElementById('visit-content').value = newContent3;
      showStatus('✅ アセスメント統合をA欄に挿入しました');
      return;
    }
    navigator.clipboard.writeText(extracted).then(function() { showStatus('✅ アセスメント統合をコピーしました（A欄が見つからないためクリップボードへ）'); });
  }
}

function copyHyokaOnly(patientId) {
  var el = document.getElementById('hyoka-' + patientId);
  if (!el) { showStatus('⚠️ 評価が見つかりません'); return; }
  var text = el.innerText || el.textContent;
  navigator.clipboard.writeText(text.trim()).then(function() { showStatus('✅ 評価をコピーしました'); });
}

// 一括評価コピーボタンのイベントデリゲーション
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('copy-hyoka-btn')) {
    var pid = e.target.getAttribute('data-patient-id');
    copyHyokaOnly(pid);
  }
});

function copyCardText(btn) {
  var card = btn.parentElement;
  var text = card.innerText.replace('📋 コピー', '').trim();
  navigator.clipboard.writeText(text).then(function() { showStatus('✅ コピーしました'); });
}

// ===== 報告書タブ 患者選択 =====
async function loadReportPatients() {
  var list = document.getElementById('report-patient-list');
  if (!list) return;
  try {
    var patients = await supabaseFetch('patients?order=name.asc');
    if (!patients.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--text-light);padding:8px">患者がいません</div>';
      return;
    }
    list.innerHTML = patients.map(function(p) {
      var checked = currentPatient && currentPatient.id === p.id ? 'checked' : '';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 8px;border-bottom:1px solid var(--border)">' +
        '<span style="font-size:13px;font-weight:700">' + p.name + '</span>' +
        '<input type="checkbox" data-id="' + p.id + '" data-name="' + p.name + '" ' + checked + ' onchange="updateReportPatientCount()" style="width:18px;height:18px;cursor:pointer">' +
        '</div>';
        '</label>';
    }).join('');
    updateReportPatientCount();
    // チェックされた患者をcurrentPatientとして使う
    var checked = list.querySelector('input[type=checkbox]:checked');
    if (checked) {
      var id = checked.getAttribute('data-id');
      var latest = await supabaseFetch('patients?id=eq.' + id);
      if (latest.length) currentPatient = latest[0];
    }
  } catch(e) {
    console.error(e);
  }
}

function updateReportPatientCount() {
  var checks = document.querySelectorAll('#report-patient-list input[type=checkbox]:checked');
  var countEl = document.getElementById('report-patient-count');
  if (countEl) countEl.textContent = checks.length + '人選択中';

  // 最初にチェックされた患者をcurrentPatientに設定
  if (checks.length > 0) {
    var id = checks[0].getAttribute('data-id');
    supabaseFetch('patients?id=eq.' + id).then(function(latest) {
      if (latest.length) currentPatient = latest[0];
    });
  }
}


// ===== 患者情報編集 =====
async function editPatientBtn(btn) {
  var id = btn.getAttribute('data-id');
  try {
    var patients = await supabaseFetch('patients?id=eq.' + id);
    if (!patients.length) return;
    var p = patients[0];

    // 患者登録タブに移動してフォームに値をセット
    switchTab('register');

    // フォームに値を入れる
    document.getElementById('reg-name').value = p.name || '';
    document.getElementById('reg-age').value = p.age || '';
    document.getElementById('reg-gender').value = p.gender || '';
    var nurseEl = document.getElementById('reg-nurse');
    if (nurseEl) nurseEl.value = p.nurse || '';
    document.getElementById('reg-diagnosis').value = p.main_diagnosis || '';
    document.getElementById('reg-history').value = p.medical_history || '';
    document.getElementById('reg-procedures').value = p.medical_procedures || '';
    setAdlFromJson(p.adl || '');
    document.getElementById('reg-notes').value = p.notes || '';
    renderMedicineRows('reg-medicines-rows', p.medicines || '');
    var clEl = document.getElementById('reg-care-level');
    if (clEl) clEl.value = p.care_level || '';
    var ilEl = document.getElementById('reg-independence');
    if (ilEl) ilEl.value = p.independence_level || '';
    var dlEl = document.getElementById('reg-dementia-level');
    if (dlEl) dlEl.value = p.dementia_level || '';
    var lsEl = document.getElementById('reg-living-situation');
    if (lsEl) lsEl.value = p.living_situation || '';
    var kpEl = document.getElementById('reg-key-person');
    if (kpEl) kpEl.value = p.key_person || '';
    var ecEl = document.getElementById('reg-emergency-contact');
    if (ecEl) ecEl.value = p.emergency_contact || '';
    var cnEl = document.getElementById('reg-caregiver-notes');
    if (cnEl) cnEl.value = p.caregiver_notes || '';

    // 編集モードのIDを保持・保存ボタンのテキスト変更
    window.editingPatientId = id;
    var saveBtn = document.querySelector('button[onclick="savePatient()"]');
    if (saveBtn) {
      saveBtn.innerHTML = '💾 患者情報を更新する';
      saveBtn.style.background = 'linear-gradient(135deg, #e8a838 0%, #f5c86a 100%)';
    }

    // タブを表示
    var regTab = document.getElementById('tab-register');
    if (regTab) regTab.style.display = '';

    showStatus('✅ ' + p.name + 'さんの情報を読み込みました。修正して更新してください');
  } catch(e) {
    showStatus('⚠️ 読み込みに失敗しました: ' + e.message, 5000);
  }
}


// ===== 患者詳細表示・編集 =====
function togglePatientDetail() {
  if (!currentPatient) return;
  var detail = document.getElementById('patient-detail');
  var btn = document.getElementById('patient-detail-btn');
  var isHidden = detail.style.display === 'none';

  if (isHidden) {
    var p = currentPatient;
    var rows = [
      { label: '担当看護師', value: p.nurse },
      { label: '主病名', value: p.main_diagnosis },
      { label: '既往歴', value: p.medical_history },
      { label: '医療処置', value: p.medical_procedures },
      { label: 'ADL', value: adlJsonToText(p.adl) },
      { label: '特記事項', value: p.notes },
      { label: '生活状況', value: p.living_situation },
      { label: 'キーパーソン', value: p.key_person },
      { label: '緊急連絡先', value: p.emergency_contact },
      { label: '介護者・家族の状況', value: p.caregiver_notes },
    ].filter(function(r) { return r.value; });

    var html = rows.map(function(r) {
      return '<div style="margin-bottom:10px">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text-secondary);margin-bottom:2px">' + r.label + '</div>' +
        '<div style="font-size:13px;line-height:1.6;white-space:pre-wrap">' + r.value + '</div>' +
        '</div>';
    }).join('');

    if (!html) html = '<div style="font-size:13px;color:var(--text-light)">詳細情報が登録されていません</div>';

    document.getElementById('patient-detail-content').innerHTML = html;
    detail.style.display = '';
    btn.textContent = '詳細を閉じる';
  } else {
    detail.style.display = 'none';
    btn.textContent = '詳細を見る';
  }
}

function editCurrentPatient() {
  if (!currentPatient) return;
  // 患者登録タブで編集モードに
  var regTab = document.getElementById('tab-register');
  if (regTab) regTab.style.display = '';
  switchTab('register');

  var p = currentPatient;
  document.getElementById('reg-name').value = p.name || '';
  document.getElementById('reg-age').value = p.age || '';
  document.getElementById('reg-gender').value = p.gender || '';
  var nurseEl = document.getElementById('reg-nurse');
  if (nurseEl) nurseEl.value = p.nurse || '';
  document.getElementById('reg-diagnosis').value = p.main_diagnosis || '';
  document.getElementById('reg-history').value = p.medical_history || '';
  document.getElementById('reg-procedures').value = p.medical_procedures || '';
  setAdlFromJson(p.adl || '');
  document.getElementById('reg-notes').value = p.notes || '';
  renderMedicineRows('reg-medicines-rows', p.medicines || '');
  var lsEl2 = document.getElementById('reg-living-situation');
  if (lsEl2) lsEl2.value = p.living_situation || '';
  var kpEl2 = document.getElementById('reg-key-person');
  if (kpEl2) kpEl2.value = p.key_person || '';
  var ecEl2 = document.getElementById('reg-emergency-contact');
  if (ecEl2) ecEl2.value = p.emergency_contact || '';
  var cnEl2 = document.getElementById('reg-caregiver-notes');
  if (cnEl2) cnEl2.value = p.caregiver_notes || '';

  window.editingPatientId = p.id;
  var saveBtn = document.querySelector('button[onclick="savePatient()"]');
  if (saveBtn) {
    saveBtn.innerHTML = '💾 患者情報を更新する';
    saveBtn.style.background = 'linear-gradient(135deg, #e8a838 0%, #f5c86a 100%)';
  }
  showStatus('✅ ' + p.name + 'さんの情報を編集できます');
}

// ===== 患者削除 =====
async function deletePatient(btn) {
  if (!currentStaffInfo || currentStaffInfo.role !== 'admin') {
    showStatus('⚠️ 患者の削除は管理者のみ操作できます', 4000);
    return;
  }
  var id = btn.getAttribute('data-id');
  if (!confirm('この患者を削除しますか？\n関連する訪問記録・書類も全て削除されます。')) return;
  try {
    await supabaseFetch('patients?id=eq.' + id, 'DELETE');
    showStatus('🗑️ 患者を削除しました');
    if (currentPatient && currentPatient.id === id) {
      currentPatient = null;
      document.getElementById('tab-record').style.display = 'none';
      document.getElementById('tab-report').style.display = 'none';
      switchTab('patients');
    }
    loadPatients();
  } catch(e) {
    showStatus('⚠️ 削除に失敗しました: ' + e.message, 5000);
  }
}

// ===== スケジュール管理 =====
// ローカル日付を YYYY-MM-DD 文字列で返す（UTC変換しない）
function localDateStr(d) {
  d = d || new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// 表示中の日付（デフォルト：今日）
window.scheduleViewDate = localDateStr();

function formatScheduleDateLabel(dateStr) {
  var todayStr = localDateStr();
  // タイムゾーンずれを避けるためローカルコンストラクタで生成
  var parts = dateStr.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  var todayParts = todayStr.split('-');
  var todayD = new Date(parseInt(todayParts[0]), parseInt(todayParts[1]) - 1, parseInt(todayParts[2]));
  var mm = d.getMonth() + 1;
  var dd = d.getDate();
  var weeks = ['日','月','火','水','木','金','土'];
  var dow = weeks[d.getDay()];
  var diff = Math.round((d - todayD) / 86400000);
  var label = diff === -1 ? '昨日' : diff === 0 ? '今日' : diff === 1 ? '明日' : '';
  return (label ? label + ' ' : '') + mm + '/' + dd + '（' + dow + '）';
}

function scheduleNavDate(offset) {
  // ローカル日付パーツから生成してUTC変換を回避
  var parts = window.scheduleViewDate.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  d.setDate(d.getDate() + offset);
  window.scheduleViewDate = localDateStr(d);
  loadTodaySchedule();
}

async function loadTodaySchedule() {
  var today = window.scheduleViewDate || new Date().toISOString().split('T')[0];
  var list = document.getElementById('today-schedule-list');
  if (!list) return;
  // 日付ラベル更新
  var label = document.getElementById('schedule-date-label');
  if (label) label.textContent = formatScheduleDateLabel(today);
  try {
    var [schedules, todayVisits] = await Promise.all([
      supabaseFetch('schedules?visit_date=eq.' + today + '&order=visit_time.asc'),
      supabaseFetch('visits?visit_date=eq.' + today)
    ]);
    // 表示日の記録済み patient_id を Set で管理
    var visitedIds = new Set(todayVisits.map(function(v) { return String(v.patient_id); }));
    var isToday = today === new Date().toISOString().split('T')[0];
    if (!schedules.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--text-light);text-align:center;padding:12px 0">スケジュールはありません</div>';
    } else {
      list.innerHTML = schedules.map(function(s) {
        var visited = visitedIds.has(String(s.patient_id));
        var rowStyle = visited
          ? 'display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);background:#f0faf5;border-radius:6px;padding-left:4px'
          : 'display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)';
        var badge = visited
          ? '<span style="font-size:10px;font-weight:700;color:#fff;background:#2e9e6e;border-radius:10px;padding:2px 7px;white-space:nowrap">記録済</span>'
          : '<span style="font-size:10px;font-weight:700;color:var(--text-light);background:var(--surface2);border-radius:10px;padding:2px 7px;white-space:nowrap">未記録</span>';
        return '<div style="' + rowStyle + '">' +
          '<div style="font-size:13px;font-weight:700;color:var(--primary);min-width:45px">' + (s.visit_time ? s.visit_time.slice(0,5) : '−') + '</div>' +
          '<div style="flex:1;cursor:pointer" data-pid="' + s.patient_id + '" onclick="selectPatientByIdEl(this)">' +
          '<div style="font-size:13px;font-weight:700">' + (s.notes || '−') + '</div>' +
          '<div style="font-size:11px;color:var(--text-secondary)">' + (s.staff_name || '') + '</div>' +
          '</div>' +
          badge +
          '<button data-id="' + s.id + '" onclick="deleteScheduleBtn(this)" style="background:none;border:none;color:#ccc;cursor:pointer;font-size:14px">×</button>' +
          '</div>';
      }).join('');
    }
    // 患者データをキャッシュ（検索用）
    window.allPatientsCache = await supabaseFetch('patients?order=name.asc');
  } catch(e) {
    list.innerHTML = '<div style="font-size:12px;color:var(--error)">読み込みエラー</div>';
  }
}

function selectPatientByIdEl(el) {
  var id = el.getAttribute('data-pid');
  if (id) selectPatientByIdStr(id);
}

async function selectPatientByIdStr(id) {
  if (!id) return;
  try {
    var latest = await supabaseFetch('patients?id=eq.' + id);
    if (latest.length) selectPatient(latest[0]);
  } catch(e) {}
}

// スケジュール患者ドロップダウンのイベントデリゲーション
document.addEventListener('click', function(e) {
  var dropdown = document.getElementById('sch-patient-dropdown');
  var search = document.getElementById('sch-patient-search');
  if (!dropdown) return;
  // ドロップダウン内のクリック
  var item = e.target.closest('[data-pid]');
  if (item && dropdown.contains(item)) {
    var pid = item.getAttribute('data-pid');
    var pname = window.schPatientMap ? window.schPatientMap[pid] : '';
    if (pid && pname) selectSchPatient(pid, pname);
    return;
  }
  // 外側クリックで閉じる
  if (search && !search.contains(e.target) && !dropdown.contains(e.target)) {
    dropdown.style.display = 'none';
  }
});

function toggleScheduleAdd() {
  var area = document.getElementById('schedule-add-area');
  area.style.display = area.style.display === 'none' ? '' : 'none';
}

async function saveSchedule() {
  var patientId = document.getElementById('sch-patient-id') ? document.getElementById('sch-patient-id').value : '';
  var patientName = document.getElementById('sch-patient-name-val') ? document.getElementById('sch-patient-name-val').value : '';
  var staff = document.getElementById('sch-staff').value.trim();
  var time = document.getElementById('sch-time').value;
  var notes = document.getElementById('sch-notes').value.trim();
  if (!patientId) { showStatus('⚠️ 患者を選択してください'); return; }
  var targetDate = window.scheduleViewDate || new Date().toISOString().split('T')[0];
  try {
    await supabaseFetch('schedules', 'POST', {
      visit_date: targetDate,
      patient_id: patientId,
      staff_name: staff || null,
      visit_time: time || null,
      notes: patientName + (notes ? ' · ' + notes : '')
    });
    document.getElementById('sch-patient-search').value = '';
    document.getElementById('sch-patient-id').value = '';
    document.getElementById('sch-patient-name-val').value = '';
    document.getElementById('sch-staff').value = '';
    document.getElementById('sch-time').value = '';
    document.getElementById('sch-notes').value = '';
    document.getElementById('schedule-add-area').style.display = 'none';
    showStatus('✅ スケジュールを追加しました');
    loadTodaySchedule();
  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  }
}

function deleteScheduleBtn(btn) {
  var id = btn.getAttribute('data-id');
  if (!confirm('削除しますか？')) return;
  supabaseFetch('schedules?id=eq.' + id, 'DELETE').then(function() {
    showStatus('🗑️ 削除しました');
    loadTodaySchedule();
  }).catch(function(e) {
    showStatus('⚠️ 削除に失敗しました: ' + e.message, 5000);
  });
}

// ===== 一般AI看護相談（患者未選択） =====
var generalChatHistory = [];

async function sendGeneralChat() {
  var input = document.getElementById('general-chat-input');
  var msg = input.value.trim();
  if (!msg) return;
  var msgs = document.getElementById('general-chat-messages');
  msgs.innerHTML += '<div style="background:var(--surface2);padding:8px 12px;border-radius:12px 12px 2px 12px;font-size:12px;max-width:90%;align-self:flex-end;margin-left:auto;line-height:1.6">' + msg + '</div>';
  input.value = '';
  msgs.scrollTop = msgs.scrollHeight;
  generalChatHistory.push({ role: 'user', content: msg });
  try {
    var res = await fetch('/.netlify/functions/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 800,
        system: 'あなたは経験豊富な訪問看護師・看護教育者です。看護・医療・リハビリに関する質問に専門的かつわかりやすく答えてください。簡潔に。',
        messages: generalChatHistory.slice(-10)
      })
    });
    var data = await res.json();
    var reply = data.content[0].text;
    generalChatHistory.push({ role: 'assistant', content: reply });
    msgs.innerHTML += '<div style="background:var(--primary);color:white;padding:8px 12px;border-radius:12px 12px 12px 2px;font-size:12px;max-width:90%;line-height:1.7;white-space:pre-wrap">' + reply + '</div>';
    msgs.scrollTop = msgs.scrollHeight;
  } catch(e) {
    msgs.innerHTML += '<div style="font-size:12px;color:var(--error);padding:6px">⚠️ エラー: ' + e.message + '</div>';
  }
}

function clearGeneralChat() {
  generalChatHistory = [];
  document.getElementById('general-chat-messages').innerHTML = '<div style="background:var(--primary);color:white;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:12px;line-height:1.6">看護・医療に関することなら何でも聞いてください！</div>';
}

// ===== 申し送りメモ =====
async function loadMemos() {
  if (!currentPatient) return;
  var board = document.getElementById('memo-board');
  var list = document.getElementById('memo-list');
  try {
    var memos = await supabaseFetch('memos?patient_id=eq.' + currentPatient.id + '&order=created_at.desc');
    board.style.display = '';
    if (!memos.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--text-light);padding:6px 0">申し送りメモはありません</div>';
      return;
    }
    list.innerHTML = memos.map(function(m) {
      var date = m.created_at ? m.created_at.slice(0,10) : '';
      var memoId = 'memo-content-' + m.id;
      return '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid #f5d98a">' +
        '<div style="flex:1">' +
        '<div id="' + memoId + '" style="font-size:13px;line-height:1.6;white-space:pre-wrap">' + m.content + '</div>' +
        '<div style="font-size:11px;color:#c47d00;margin-top:3px">' + (m.created_by ? m.created_by + ' · ' : '') + date + '</div>' +
        '</div>' +
        '<button onclick="copyMemoById(\'' + memoId + '\')" style="background:none;border:none;color:#c47d00;cursor:pointer;font-size:13px;padding:0 4px;flex-shrink:0" title="コピー">📋</button>' +
        '<button data-id="' + m.id + '" onclick="deleteMemoBtn(this)" style="background:none;border:none;color:#ccc;cursor:pointer;font-size:16px;padding:0 4px;flex-shrink:0">×</button>' +
        '</div>';
    }).join('');
  } catch(e) {
    console.error('メモ読み込みエラー:', e);
  }
}

function toggleMemoAdd() {
  var area = document.getElementById('memo-add-area');
  var isHidden = area.style.display === 'none';
  area.style.display = isHidden ? '' : 'none';
  if (isHidden) document.getElementById('memo-input').focus();
}

async function saveMemo() {
  if (!currentPatient) return;
  var content = document.getElementById('memo-input').value.trim();
  var author = document.getElementById('memo-author').value.trim();
  if (!content) { showStatus('⚠️ 内容を入力してください'); return; }
  try {
    await supabaseFetch('memos', 'POST', {
      patient_id: currentPatient.id,
      content: content,
      created_by: author || null
    });
    document.getElementById('memo-input').value = '';
    document.getElementById('memo-add-area').style.display = 'none';
    showStatus('✅ メモを保存しました');
    loadMemos();
  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  }
}

function deleteMemoBtn(btn) {
  var id = btn.getAttribute('data-id');
  deleteMemo(id);
}

async function deleteMemo(id) {
  if (!confirm('このメモを削除しますか？')) return;
  try {
    await supabaseFetch('memos?id=eq.' + id, 'DELETE');
    showStatus('🗑️ 削除しました');
    loadMemos();
  } catch(e) {
    showStatus('⚠️ 削除に失敗しました: ' + e.message, 5000);
  }
}

// ===== AI看護相談チャット =====
var nursingChatHistory = [];

function initNursingChat() {
  nursingChatHistory = [];
  var msgs = document.getElementById('nursing-chat-messages');
  if (msgs) {
    msgs.innerHTML = '<div style="background:var(--primary);color:white;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:13px;max-width:90%;line-height:1.6">' +
      (currentPatient
        ? currentPatient.name + 'さんについて何でも相談できます。\n看護・リハビリ・疾患知識・ケアの根拠など、学習・勉強の質問もOKです。'
        : '患者を選択してください。') +
      '</div>';
  }
  var input = document.getElementById('nursing-chat-input');
  var btn = document.getElementById('nursing-chat-btn');
  if (input) { input.disabled = !currentPatient; input.value = ''; }
  if (btn) btn.disabled = !currentPatient;
}

function clearNursingChat() {
  nursingChatHistory = [];
  initNursingChat();
}

async function sendNursingChat() {
  if (!currentPatient) return;
  var input = document.getElementById('nursing-chat-input');
  var msg = input.value.trim();
  if (!msg) return;

  var msgs = document.getElementById('nursing-chat-messages');
  var btn = document.getElementById('nursing-chat-btn');

  // ユーザーメッセージ表示
  msgs.innerHTML += '<div style="background:var(--surface2);padding:10px 14px;border-radius:12px 12px 2px 12px;font-size:13px;max-width:90%;align-self:flex-end;margin-left:auto;line-height:1.6">' + msg + '</div>';
  input.value = '';
  btn.disabled = true;
  btn.textContent = '…';
  msgs.scrollTop = msgs.scrollHeight;

  nursingChatHistory.push({ role: 'user', content: msg });

  try {
    // 全訪問記録を取得（件数制限なし）
    var visits = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&order=visit_date.asc');
    var visitText = visits.map(function(v) {
      return '【' + v.visit_date + '】' + (v.content || '') + (v.observations ? ' 申し送り：' + v.observations : '');
    }).join('\n\n');

    // 現在の記録入力中の内容も含める
    var currentRecord = document.getElementById('visit-content').value.trim();

    var systemPrompt = 'あなたは経験豊富な訪問看護師・リハビリ専門家・看護教育者です。以下の役割を担います：\n' +
      '①この患者に関する看護相談・アセスメントの相談に答える\n' +
      '②リハビリ相談（PT・OT・ST領域）：歩行・ADL・嚥下・上肢機能・認知機能・自主トレ指導・多職種連携など\n' +
      '③看護師・看護学生・新人看護師・リハビリスタッフへの教育・学習支援\n' +
      '④エビデンスに基づいた実践的なアドバイス\n\n' +
      '患者に関する質問は患者情報・記録（看護記録・リハビリ記録両方）を踏まえて答えてください。一般的な知識の質問は丁寧にわかりやすく、新人や学生には根拠も含めて説明してください。回答は簡潔かつ実用的に。' +
      '\n\n【患者情報】\n氏名：' + currentPatient.name + '（' + (currentPatient.age||'不明') + '歳・' + (currentPatient.gender||'不明') + '）\n主病名：' + (currentPatient.main_diagnosis||'') +
      '\n既往歴：' + (currentPatient.medical_history||'') + '\n医療処置：' + (currentPatient.medical_procedures||'') +
      '\nADL：' + adlJsonToText(currentPatient.adl||'') + '\n内服薬：' + (currentPatient.medicines||'なし') +
      '\n\n【直近の訪問記録】\n' + (visitText||'記録なし') +
      (currentRecord ? '\n\n【本日入力中の記録】\n' + currentRecord : '');

    // 会話履歴を構築
    var messages = nursingChatHistory.slice(-10); // 直近10件

    var res = await fetch('/.netlify/functions/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        system: systemPrompt,
        messages: messages
      })
    });

    var data = await res.json();
    var reply = data.content[0].text;
    nursingChatHistory.push({ role: 'assistant', content: reply });

    msgs.innerHTML += '<div style="background:var(--primary);color:white;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:13px;max-width:90%;line-height:1.7;white-space:pre-wrap">' + reply + '</div>';
    msgs.scrollTop = msgs.scrollHeight;

  } catch(e) {
    msgs.innerHTML += '<div style="background:#fdf0f0;color:var(--error);padding:10px 14px;border-radius:12px;font-size:13px;">⚠️ エラー: ' + e.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = '送信';
  }
}


// ===== JCS/GCS ポップアップ =====
var gcsScores = { E: 0, V: 0, M: 0 };

function showJcsGcs() {
  document.getElementById('jcs-gcs-modal').style.display = '';
}

function closeJcsGcs() {
  document.getElementById('jcs-gcs-modal').style.display = 'none';
}

function applyJcs(code) {
  var display = 'JCS ' + code;
  document.getElementById('vt-consciousness').value = display;
  document.getElementById('vt-consciousness-display').textContent = display;
  closeJcsGcs();
  showStatus('✅ ' + display + ' をセットしました');
}

function applyGcs(code) {
  var type = code.charAt(0);
  var score = parseInt(code.slice(1));
  gcsScores[type] = score;

  // 同じ行（E/V/M）の前の選択を解除してハイライト
  document.querySelectorAll('#jcs-gcs-modal [data-gcs-type="' + type + '"]').forEach(function(el) {
    el.style.background = '';
    el.style.color = '';
    el.style.fontWeight = '';
  });
  event.currentTarget.style.background = 'var(--primary)';
  event.currentTarget.style.color = 'white';
  event.currentTarget.style.fontWeight = '700';

  var total = (gcsScores.E||0) + (gcsScores.V||0) + (gcsScores.M||0);
  var eStr = gcsScores.E ? 'E'+gcsScores.E : 'E−';
  var vStr = gcsScores.V ? 'V'+gcsScores.V : 'V−';
  var mStr = gcsScores.M ? 'M'+gcsScores.M : 'M−';
  document.getElementById('gcs-total').textContent = total > 0 ? total : '−';
  document.getElementById('gcs-detail').textContent = '（' + eStr + vStr + mStr + '）';
}

function applyGcsTotal() {
  var E = gcsScores.E, V = gcsScores.V, M = gcsScores.M;
  if (!E || !V || !M) { showStatus('⚠️ E・V・Mすべて選択してください'); return; }
  var total = E + V + M;
  var value = 'GCS E' + E + 'V' + V + 'M' + M + '(' + total + '点)';
  document.getElementById('vt-consciousness').value = value;
  var disp = document.getElementById('vt-consciousness-display');
  if (disp) disp.textContent = value;
  gcsScores = { E: 0, V: 0, M: 0 };
  // ハイライトリセット
  document.querySelectorAll('#jcs-gcs-modal [data-gcs-type]').forEach(function(el) {
    el.style.background = ''; el.style.color = ''; el.style.fontWeight = '';
  });
  document.getElementById('gcs-total').textContent = '−';
  document.getElementById('gcs-detail').textContent = '';
  closeJcsGcs();
  showStatus('✅ ' + value + ' をセットしました');
}

// ===== バイタル入力ヘルパー =====
function vitalNext(input, digits, nextId) {
  var val = input.value.replace(/[^0-9]/g, '');
  if (val.length >= digits) {
    var next = document.getElementById(nextId);
    if (next) { next.focus(); next.select(); }
  }
}

function vitalTempKey(input) {
  var val = input.value.replace(/[^0-9]/g, '');
  if (val.length >= 3) {
    input.value = val.slice(0,2) + '.' + val.slice(2,3);
    var next = document.getElementById('vt-bp-h');
    if (next) { next.focus(); next.select(); }
  }
}


function vitalAutoNext(input, digits, nextId) {
  var val = String(input.value).replace(/[^0-9]/g, '');
  if (val.length >= digits) {
    var next = document.getElementById(nextId);
    if (next) {
      setTimeout(function() {
        next.focus();
        if (next.select) next.select();
      }, 10);
    }
  }
}

function vitalTempInput(input) {
  var raw = String(input.value).replace(/[^0-9]/g, '');
  if (raw.length >= 3) {
    var formatted = raw.slice(0, 2) + '.' + raw.slice(2, 3);
    var num = parseFloat(formatted);
    if (num >= 34 && num <= 42) {
      input.value = formatted;
      setTimeout(function() {
        var next = document.getElementById('vt-bp-h');
        if (next) { next.focus(); if (next.select) next.select(); }
      }, 10);
    }
  }
}

function formatTemp(input) {
  var val = input.value.replace('.', '');
  if (val.length >= 3 && !input.value.includes('.')) {
    // 364 → 36.4 / 375 → 37.5 / 365 → 36.5
    var formatted = val.slice(0, 2) + '.' + val.slice(2);
    var num = parseFloat(formatted);
    if (num >= 34 && num <= 42) {
      input.value = formatted;
    }
  }
}

function updateConsciousness() {
  var type = document.getElementById('vt-consciousness-type').value;
  var jcsInput = document.getElementById('vt-consciousness-jcs');
  var hidden = document.getElementById('vt-consciousness');
  if (type === 'JCS') {
    jcsInput.style.display = '';
    jcsInput.placeholder = '例:10';
    var jcsVal = jcsInput.value;
    hidden.value = 'JCS' + (jcsVal ? ' ' + jcsVal : '');
  } else if (type === 'GCS') {
    jcsInput.style.display = '';
    jcsInput.placeholder = '合計点';
    var gcsVal = jcsInput.value;
    hidden.value = 'GCS' + (gcsVal ? ' ' + gcsVal + '点' : '');
  } else {
    jcsInput.style.display = 'none';
    hidden.value = '清明';
  }
}

// ===== 緊急対応 =====
function toggleEmergency() {
  var area = document.getElementById('emergency-area');
  var isHidden = area.style.display === 'none';
  area.style.display = isHidden ? '' : 'none';
  var btn = event.target;
  btn.innerHTML = isHidden ? '✕ 閉じる' : '🚨 緊急訪問看護';
  if (isHidden) {
    // 開いたらすぐメモ欄にフォーカス
    setTimeout(function() {
      var memo = document.getElementById('emergency-memo');
      if (memo) memo.focus();
    }, 50);
    area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function generateEmergency() {
  var memo = document.getElementById('emergency-memo').value.trim();
  if (!memo) { showStatus('⚠️ 症状・電話内容を入力してください'); return; }

  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> AIが生成中...';

  try {
    var patientInfo = currentPatient
      ? '患者名：' + currentPatient.name + '（' + (currentPatient.age||'不明') + '歳・' + (currentPatient.gender||'不明') + '）' +
        '\n主病名：' + (currentPatient.main_diagnosis||'不明') +
        '\n既往歴：' + (currentPatient.medical_history||'不明') +
        '\n医療処置：' + (currentPatient.medical_procedures||'なし') +
        '\nADL：' + adlJsonToText(currentPatient.adl||'') +
        '\n内服薬：' + (currentPatient.medicines||'なし') +
        '\n特記事項：' + (currentPatient.notes||'') +
        '\n生活状況：' + (currentPatient.living_situation||'') +
        '\nキーパーソン：' + (currentPatient.key_person||'') +
        '\n緊急連絡先：' + (currentPatient.emergency_contact||'') +
        '\n介護者・家族の状況：' + (currentPatient.caregiver_notes||'')
      : '患者情報なし（緊急電話対応中）';

    // 直近5件の訪問記録のA欄を取得
    var recentAssessments = '';
    if (currentPatient) {
      try {
        var recentVisits = await supabaseFetch(
          'visits?patient_id=eq.' + currentPatient.id + '&order=visit_date.desc&limit=5'
        );
        var aLines = recentVisits
          .map(function(v) {
            // assessment カラムがあればそれを使用、なければ content から【A：】部分を抽出
            var aText = v.assessment || '';
            if (!aText && v.content) {
              var m = v.content.match(/【A[：:][^】]*】\s*([\s\S]*?)(?=【[SOAP]|$)/);
              if (m) aText = m[1].trim();
            }
            return aText ? '【' + v.visit_date + '】' + aText : null;
          })
          .filter(Boolean);
        if (aLines.length) recentAssessments = aLines.join('\n');
      } catch(e) { /* 取得失敗はスキップ */ }
    }

    var sysPrompt = 'あなたは経験豊富な訪問看護師です。患者情報・直近の訪問記録・今回の症状をもとに以下の2項目のみ出力してください。\n\n' +
      '【観察項目】\n今回の症状・主病名・既往歴・直近の記録を踏まえた確認すべき項目を優先度順に8〜10項目（箇条書き）。バイタルサイン測定は省略すること。\n\n' +
      '【注意点】\nこの患者固有の状況（性格・生活背景・介護状況・直近のアセスメント内容）を踏まえた現場での注意事項を3〜5点（箇条書き）。汎用的な教科書的注意点は書かない。この人だから注意すべきことを書く。\n\n' +
      '【倫理的制約】\n・本人の意思・価値観・生活習慣を否定しない\n・患者の意向を軸にしながら家族の状況も視野に入れる\n・AIの出力はあくまで看護師の判断を補助するものであり最終判断は必ず担当看護師が行う';

    var userMsg = '【電話内容・症状メモ】\n' + memo +
      '\n\n【患者情報】\n' + patientInfo +
      (recentAssessments ? '\n\n【直近の訪問記録（A欄）】\n' + recentAssessments : '');

    var result = await callClaude(sysPrompt, userMsg);

    document.getElementById('emergency-items').textContent = result;
    document.getElementById('emergency-output').style.display = '';

    // 自動でSOAP形式に変換して記録欄に転記
    var memo = document.getElementById('emergency-memo').value.trim();
    var nl = '\n';
    var t = '【S：主観的情報】' + nl;
    t += '本人・家族の訴え：' + memo + nl + nl;
    t += '【O：客観的情報】' + nl;
    t += '＜バイタル＞' + nl;
    t += '体温：　 血圧：　 脈拍：　 SpO2：　 呼吸数：' + nl;
    t += '意識レベル：' + nl + nl;

    var obsLines = [];
    var noteLines = [];
    var inObs = false;
    result.split('\n').forEach(function(line) {
      if (line.includes('【観察項目】')) { inObs = true; return; }
      if (line.includes('【注意点】')) { inObs = false; return; }
      var trimmed = line.trim();
      var isBullet = trimmed.startsWith('・') || trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ') || /^\d+[\.\.）]/.test(trimmed);
      if (isBullet) {
        var text = trimmed.replace(/^[・\-•\*]\s*/, '').replace(/^\d+[\.\.）]\s*/, '').trim();
        if (inObs) obsLines.push(text + '：');
        else noteLines.push('・' + text);
      }
    });

    if (obsLines.length > 0) {
      obsLines.forEach(function(l) { t += l + nl; });
      t += nl;
    }
    t += '【A：アセスメント】' + nl + nl;
    t += '【P：プラン】' + nl;
    if (noteLines.length > 0) {
      t += nl + '【注意点】' + nl;
      noteLines.forEach(function(l) { t += l + nl; });
    }

    document.getElementById('visit-content').value = t;
    // 緊急エリアを閉じる
    var emergencyArea = document.getElementById('emergency-area');
    if (emergencyArea) emergencyArea.style.display = 'none';
    var emergencyBtn = document.querySelector('button[onclick="toggleEmergency()"]');
    if (emergencyBtn) emergencyBtn.innerHTML = '🚨 緊急訪問看護';
    showStatus('✅ SOAP形式で記録欄に転記しました');

  } catch(e) {
    showStatus('⚠️ 生成に失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🚨 AIで緊急観察項目・報告文を生成';
  }
}

function copyEmergencyToRecord() {
  var items = document.getElementById('emergency-items').textContent;
  var memo = document.getElementById('emergency-memo').value.trim();
  var nl = '\n';

  var t = '【S：主観的情報】' + nl;
  t += '本人・家族の訴え：' + memo + nl + nl;
  t += '【O：客観的情報】' + nl;
  t += '＜バイタル＞' + nl;
  t += '体温：　 血圧：　 脈拍：　 SpO2：　 呼吸数：' + nl;
  t += '意識レベル：' + nl + nl;

  var obsLines = [];
  var noteLines = [];
  var inObs = false;
  items.split('\n').forEach(function(line) {
    if (line.includes('【観察項目】')) { inObs = true; return; }
    if (line.includes('【注意点】')) { inObs = false; return; }
    var trimmed = line.trim();
    var isBullet = trimmed.startsWith('・') || trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ') || /^\d+[\.\.）]/.test(trimmed);
    if (isBullet) {
      var text = trimmed.replace(/^[・\-•\*]\s*/, '').replace(/^\d+[\.\.）]\s*/, '').trim();
      if (inObs) obsLines.push(text + '：');
      else noteLines.push('・' + text);
    }
  });

  if (obsLines.length > 0) {
    obsLines.forEach(function(l) { t += l + nl; });
    t += nl;
  }

  t += '【A：アセスメント】' + nl + nl;
  t += '【P：プラン】' + nl;
  if (noteLines.length > 0) {
    t += nl + '【注意点】' + nl;
    noteLines.forEach(function(l) { t += l + nl; });
  }

  document.getElementById('visit-content').value = t;
  // 緊急パネルを閉じて記録欄を表示
  var ep = document.getElementById('emergency-panel');
  if (ep) ep.style.display = 'none';
  // 看護師モードに切り替え
  switchStaff('ns');
  // 記録欄にスクロール
  setTimeout(function() {
    document.getElementById('visit-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('visit-content').focus();
  }, 200);
  showStatus('✅ SOAP形式で記録欄に転記しました！バイタルを入力してください');
}

// ===== 書類保存・一覧・削除 =====
async function saveDocument(type) {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }

  var title, docContent, docDate;

  if (type === 'keikaku') {
    var date = document.getElementById('k-date-display').textContent;
    var kubun = document.getElementById('k-kubun-display').textContent;
    var mokuhyo = document.getElementById('k-mokuhyo').textContent || document.getElementById('k-mokuhyo').innerText;
    var planContent = document.getElementById('k-content-col').textContent || document.getElementById('k-content-col').innerText;
    var hyoka = document.getElementById('k-hyoka-col').textContent || document.getElementById('k-hyoka-col').innerText;
    title = '訪問看護計画書 ' + date;
    docDate = document.getElementById('keikaku-date').value;
    docContent = JSON.stringify({ date: date, kubun: kubun, mokuhyo: mokuhyo, content: planContent, hyoka: hyoka });
  } else {
    var month = document.getElementById('report-month').value;
    var vital = document.getElementById('r-vital').textContent || document.getElementById('r-vital').innerText;
    var keika = document.getElementById('r-keika').textContent || document.getElementById('r-keika').innerText;
    title = '訪問看護報告書 ' + month;
    docDate = month + '-01';
    docContent = JSON.stringify({ vital: vital, keika: keika });
  }

  try {
    await supabaseFetch('documents', 'POST', {
      patient_id: currentPatient.id,
      doc_type: type,
      title: title,
      content: docContent,
      doc_date: docDate
    });
    showStatus('✅ 保存しました');
    loadDocuments(type);
  } catch(e) {
    showStatus('⚠️ 保存に失敗しました: ' + e.message, 5000);
  }
}

async function loadDocuments(type) {
  if (!currentPatient) return;
  var listId = type === 'keikaku' ? 'saved-keikaku-list' : 'saved-hokoku-list';
  var container = document.getElementById(listId);
  if (!container) return;

  try {
    var docs = await supabaseFetch('documents?patient_id=eq.' + currentPatient.id + '&doc_type=eq.' + type + '&order=created_at.desc');
    if (!docs.length) {
      container.innerHTML = '<div class="empty-state"><div class="icon">' + (type === 'keikaku' ? '📋' : '📊') + '</div><p>保存された書類はありません</p></div>';
      return;
    }
    container.innerHTML = docs.map(function(doc) {
      return '<div class="visit-card fade-in">' +
        '<div class="visit-card-header">' +
        '<div class="visit-date-label">' + (type === 'keikaku' ? '📋' : '📊') + ' ' + doc.title + '</div>' +
        '<div style="display:flex;gap:6px">' +
        '<button class="btn btn-secondary btn-sm" data-id="' + doc.id + '" data-type="' + type + '" onclick="loadDocumentBtn(this)">📂 読み込む</button>' +
        '<button class="btn btn-danger btn-sm" data-id="' + doc.id + '" data-type="' + type + '" onclick="deleteDocumentBtn(this)">削除</button>' +
        '</div></div>' +
        '<div style="font-size:12px;color:var(--text-light);margin-top:4px">' + (doc.doc_date || '') + '</div>' +
        '</div>';
    }).join('');
  } catch(e) {
    container.innerHTML = '<div class="alert alert-error">⚠️ 読み込みエラー: ' + e.message + '</div>';
  }
}

async function loadDocumentBtn(btn) {
  var id = btn.getAttribute('data-id');
  var type = btn.getAttribute('data-type');
  await loadDocument(id, type);
}
async function deleteDocumentBtn(btn) {
  var id = btn.getAttribute('data-id');
  var type = btn.getAttribute('data-type');
  await deleteDocument(id, type);
}
async function loadDocument(id, type) {
  try {
    var docs = await supabaseFetch('documents?id=eq.' + id);
    if (!docs.length) return;
    var doc = docs[0];
    var data = JSON.parse(doc.content);

    if (type === 'keikaku') {
      document.getElementById('k-date-display').textContent = data.date || '';
      document.getElementById('k-kubun-display').textContent = data.kubun || '';
      document.getElementById('k-mokuhyo').textContent = data.mokuhyo || '';
      document.getElementById('k-content-col').textContent = data.content || '';
      document.getElementById('k-hyoka-col').textContent = data.hyoka || '';
      document.getElementById('keikaku-result').style.display = '';
    } else {
      document.getElementById('r-vital').textContent = data.vital || '';
      document.getElementById('r-keika').textContent = data.keika || '';
      document.getElementById('report-card').style.display = '';
    }
    showStatus('✅ ' + doc.title + ' を読み込みました');
  } catch(e) {
    showStatus('⚠️ 読み込みに失敗しました: ' + e.message, 5000);
  }
}

async function deleteDocument(id, type) {
  if (!confirm('この書類を削除しますか？')) return;
  try {
    await supabaseFetch('documents?id=eq.' + id, 'DELETE');
    showStatus('🗑️ 削除しました');
    loadDocuments(type);
  } catch(e) {
    showStatus('⚠️ 削除に失敗しました: ' + e.message, 5000);
  }
}

// ===== リハビリ計画書 =====
async function generateRehabPlan() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }

  const btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> AIが作成中...';

  try {
    const visits = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&order=visit_date.desc&limit=15');
    const rehabVisits = visits.filter(function(v) { return v.content && v.content.includes('記録】'); });
    const targetVisits = rehabVisits.length > 0 ? rehabVisits : visits;
    const visitText = targetVisits.map(function(v) {
      return '【' + v.visit_date + '】' + '\n' + (v.content || '') + (v.observations ? '\n申し送り：' + v.observations : '');
    }).join('\n\n');

    const patientInfo = '【患者情報】\n氏名：' + currentPatient.name + '（' + (currentPatient.age || '不明') + '歳・' + (currentPatient.gender || '不明') + '）\n主病名：' + (currentPatient.main_diagnosis || '') + '\n既往歴：' + (currentPatient.medical_history || '') + '\n医療処置：' + (currentPatient.medical_procedures || '') + '\nADL：' + adlJsonToText(currentPatient.adl || '') + '\n特記事項：' + (currentPatient.notes || '') + '\n\n【リハビリ記録（直近）】\n' + (visitText || '記録なし');

    const result = await callClaude(
      'あなたは訪問リハビリの専門家（PT・OT・ST対応）です。患者情報とリハビリ記録をもとに、訪問リハビリ計画書を作成してください。以下の構成で記載してください：1. 現在の機能評価（身体機能・ADL・認知機能）2. リハビリ上の問題点（3〜5つ）3. 短期目標（1〜3ヶ月）4. 長期目標（6ヶ月〜1年）5. リハビリ計画（PT・OT・STそれぞれ該当する内容を記載）6. 自主トレーニング指導内容 7. 家族・介護者への指導事項 8. 多職種への情報共有事項。専門的かつ実用的な内容で記載してください。\n\n【倫理的制約】\n・本人が望んでいない生活変容・行動変容を推奨しない\n・本人の意思・価値観・生活習慣を否定するような表現を使わない\n・「〜すべき」「〜させる必要がある」という一方的な表現を避ける\n・家族の希望を本人の意向より優先する示唆をしない\n・AIの出力はあくまで看護師の判断を補助するものであり、最終判断は必ず担当看護師が行う',
      patientInfo
    );

    document.getElementById('rehab-plan-content').textContent = result;
    document.getElementById('rehab-plan-output').style.display = '';
    document.getElementById('rehab-plan-output').scrollIntoView({ behavior: 'smooth' });

  } catch(e) {
    showStatus('⚠️ AIの呼び出しに失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🏃 リハビリ計画書';
  }
}


// ===== サブタブ切り替え =====
function switchSubTab(tab) {
  ['keikaku','hokoku'].forEach(function(t) {
    document.getElementById('panel-' + t).style.display = t === tab ? '' : 'none';
    document.getElementById('subtab-' + t).classList.toggle('active', t === tab);
  });
  loadDocuments(tab);
}

// ===== 計画書生成 =====
async function generateKeikaku() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  var date = document.getElementById('keikaku-date').value;
  var kubun = document.getElementById('keikaku-kubun').value;
  if (!date) { showStatus('⚠️ 報告日を入力してください'); return; }

  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> AIが作成中...';

  try {
    var visits = await supabaseFetch('visits?patient_id=eq.' + currentPatient.id + '&order=visit_date.desc&limit=20');
    var visitText = visits.map(function(v) {
      return '【' + v.visit_date + '】\n' + (v.content || '') + (v.observations ? '\n申し送り：' + v.observations : '');
    }).join('\n\n');

    // 観察項目を構築（保存済み + 疾患別固定リスト）
    var obsItems = '';
    if (currentPatient.observation_items) {
      obsItems = currentPatient.observation_items;
    } else {
      var commonObs = COMMON_ITEMS.slice();
      var diseaseObs = getDiseaseItems(currentPatient.main_diagnosis||'');
      if (diseaseObs) commonObs = commonObs.concat(diseaseObs.items);
      obsItems = commonObs.join('\n');
    }
    var patientInfo = '氏名：' + currentPatient.name + '（' + (currentPatient.age||'不明') + '歳・' + (currentPatient.gender||'不明') + '）\n主病名：' + (currentPatient.main_diagnosis||'') + '\n既往歴：' + (currentPatient.medical_history||'') + '\n医療処置：' + (currentPatient.medical_procedures||'') + '\nADL：' + adlJsonToText(currentPatient.adl||'') + '\n特記事項：' + (currentPatient.notes||'') + '\n要介護度：' + (currentPatient.care_level||'') + '\n障害高齢者自立度：' + (currentPatient.independence_level||'') + '\n認知症自立度：' + (currentPatient.dementia_level||'');

    // 保存済み目標があれば使用、なければAIに生成させる
    var savedGoalLong = currentPatient.goal_long || '';
    var savedGoalShort = currentPatient.goal_short || '';
    var goalInstruction = savedGoalLong
      ? '"mokuhyo_long":"' + savedGoalLong + '","mokuhyo_short":"' + savedGoalShort + '"'
      : '"mokuhyo_long":"長期目標のテキスト","mokuhyo_short":"短期目標のテキスト"';

    var result = await callClaude(
      'あなたは訪問看護師です。以下のJSON形式のみで回答してください。余分なテキスト不要。\n{' + goalInstruction + ',"content":"（以下の形式を厳守）\\n#1 問題名（主病名に基づく）\\n【O-P】\\n・観察項目1\\n・観察項目2\\n【T-P】\\n・ケア項目1\\n・ケア項目2\\n【E-P】\\n・教育項目1\\n\\n#2 問題名\\n【O-P】\\n・観察項目\\n【T-P】\\n・ケア項目\\n【E-P】\\n・教育項目\\n（3つ以上問題がある場合は#3も記載）","hyoka":"・評価1\\n・評価2\\n・プラン継続"}' + (savedGoalLong ? '\n重要：mokuhyo_longは「' + savedGoalLong + '」、mokuhyo_shortは「' + savedGoalShort + '」をそのまま使うこと。' : '') + '\n\n【倫理的制約】\n・本人が望んでいない生活変容・行動変容を推奨しない\n・本人の意思・価値観・生活習慣を否定するような表現を使わない\n・「〜すべき」「〜させる必要がある」という一方的な表現を避ける\n・家族の希望を本人の意向より優先する示唆をしない\n・AIの出力はあくまで看護師の判断を補助するものであり、最終判断は必ず担当看護師が行う',
      '【患者情報】\n' + patientInfo + '\n\n【患者登録時の観察項目（O-Pに必ず反映すること）】\n' + obsItems + '\n\n【訪問記録】\n' + (visitText||'記録なし')
    );

    var data;
    try {
      var clean = result.replace(/```json|```/g, '').trim();
      // JSONの改行を安全に処理
      data = JSON.parse(clean);
    } catch(e) {
      // JSON解析失敗時はテキストをそのままcontentに入れる
      try {
        // 改行をエスケープして再試行
        var escaped = clean.replace(/([^\\])\n/g, '$1\\n').replace(/^\n/, '\\n');
        data = JSON.parse(escaped);
      } catch(e2) {
        // それでも失敗したらテキスト全体をcontentとして使用
        data = { mokuhyo_long: '', mokuhyo_short: '', content: result, hyoka: '・プラン継続' };
      }
    }

    // 日付をワイズマン形式に変換（令和）
    var d = new Date(date);
    var reiwa = d.getFullYear() - 2018;
    var months = ['01','02','03','04','05','06','07','08','09','10','11','12'];
    var days = ['日','月','火','水','木','金','土'];
    var waDate = '令和' + String(reiwa).padStart(2,'0') + '年' + months[d.getMonth()] + '月' + String(d.getDate()).padStart(2,'0') + '日（' + days[d.getDay()] + '）';

    // 先にkeikaku-resultを表示してからDOM要素にアクセス
    document.getElementById('keikaku-result').style.display = '';
    document.getElementById('k-date-display').textContent = waDate;
    document.getElementById('k-kubun-display').textContent = kubun;
    document.getElementById('k-mokuhyo').textContent = '長期目標：' + (data.mokuhyo_long||'') + '\n短期目標：' + (data.mokuhyo_short||'');
    document.getElementById('k-date-col').textContent = waDate;
    document.getElementById('k-content-col').textContent = (data.content || (data.mondai||'') + '\n\n【観察項目】' + (data.kansatsu||'') + '\n\n【実施項目】' + (data.jisshi||'') + '\n\n【指導項目】' + (data.shido||''));
    document.getElementById('k-hyoka-col').textContent = data.hyoka||'';
    document.getElementById('keikaku-result').scrollIntoView({ behavior: 'smooth' });
    showStatus('✅ 計画書を生成しました');

  } catch(e) {
    showStatus('⚠️ 生成に失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🤖 AIで計画書を生成';
  }
}

function copyKeikaku() {
  var date = document.getElementById('k-date-display').textContent;
  var kubun = document.getElementById('k-kubun-display').textContent;
  var mokuhyo = document.getElementById('k-mokuhyo').textContent;
  var content = document.getElementById('k-content-col').textContent;
  var hyoka = document.getElementById('k-hyoka-col').textContent;
  var text = '訪問看護計画書\n報告日：' + date + '\n看護区分：' + kubun + '\n\n【看護・リハビリテーションの目標】\n' + mokuhyo + '\n\n【看護計画】\n' + content + '\n\n【評価】\n' + hyoka;
  navigator.clipboard.writeText(text).then(function() { showStatus('✅ コピーしました'); });
}

function copyReport() {
  var vital = document.getElementById('r-vital').textContent;
  var keika = document.getElementById('r-keika').textContent;
  var text = '訪問看護報告書\n\nバイタル：' + vital + '\n\n病状の経過\n' + keika;
  navigator.clipboard.writeText(text).then(function() { showStatus('✅ コピーしました'); });
}

// ===== 月次報告書（ワイズマン形式） =====
async function generateReport() {
  if (!currentPatient) { showStatus('⚠️ 患者を選択してください'); return; }
  const month = document.getElementById('report-month').value;
  if (!month) { showStatus('⚠️ 対象年月を選択してください'); return; }

  const btn = event.target;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dot"><span></span><span></span><span></span></span> AIが作成中...';

  try {
    const [year, m] = month.split('-');
    const visits = await supabaseFetch(
      `visits?patient_id=eq.${currentPatient.id}&visit_date=gte.${month}-01&visit_date=lt.${String(parseInt(month.split('-')[0]) + (month.split('-')[1]==='12'?1:0))}-${String(parseInt(month.split('-')[1])%12+1).padStart(2,'0')}-01&order=visit_date.asc`
    );
    const visitText = visits.map(v => `【${v.visit_date}】\n${v.content || ''}${v.observations ? '\n申し送り：' + v.observations : ''}`).join('\n\n');

    const result = await callClaude(
      `あなたは訪問看護師です。訪問看護報告書をJSON形式で作成してください。以下の形式のみで回答してください：{"vital":"月間バイタルの範囲（例：体温(35.5〜36.8℃) 脈拍(60〜80回/分) 血圧(110〜140/60〜85mmHg) SpO2(95〜99%)）","keika":"【看護職員】\n・箇条書きで今月の病状経過（バイタルの記載は不要。症状・状態変化・対応内容のみ）\n\n【理学療法士】\n・リハビリがある場合のみ記載（なければ省略）",}。keika は実際の記録から具体的に、バイタル数値は含めず症状・変化・対応を簡潔に記載すること。\n\n【倫理的制約】\n・本人が望んでいない生活変容・行動変容を推奨しない\n・本人の意思・価値観・生活習慣を否定するような表現を使わない\n・「〜すべき」「〜させる必要がある」という一方的な表現を避ける\n・家族の希望を本人の意向より優先する示唆をしない\n・AIの出力はあくまで看護師の判断を補助するものであり、最終判断は必ず担当看護師が行う`,
      `【患者情報】
氏名：${currentPatient.name}（${currentPatient.age || '不明'}歳・${currentPatient.gender || '不明'}）
主病名：${currentPatient.main_diagnosis || ''}
既往歴：${currentPatient.medical_history || ''}
医療処置：${currentPatient.medical_procedures || ''}
ADL：${adlJsonToText(currentPatient.adl || '')}
特記事項：${currentPatient.notes || ''}

【対象期間】${year}年${parseInt(m)}月
【訪問回数】${visits.length}回

【訪問記録】
${visitText || '記録なし'}`
    );

    // JSONで受け取ってワイズマン形式に表示
    var reportData;
    try {
      var clean = result.replace(/```json|```/g, '').trim();
      reportData = JSON.parse(clean);
    } catch(e) {
      // JSONでない場合はそのまま病状の経過に入れる
      reportData = { vital: '', keika: result, jisshi: '訪問看護計画書参照', kango: '' };
    }
    document.getElementById('r-vital').textContent = reportData.vital || '';
    document.getElementById('r-keika').textContent = reportData.keika || '';
    document.getElementById('report-card').style.display = '';
    document.getElementById('report-card').scrollIntoView({ behavior: 'smooth' });

  } catch(e) {
    showStatus('⚠️ AIの呼び出しに失敗しました: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🤖 AIで月次報告書を生成';
  }
}

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', function() {
  // ===== バージョンチェック・自動更新 =====
  var currentVersion = '202604121000';
  try {
    var savedVersion = localStorage.getItem('nurseapp_version');
    if (savedVersion && savedVersion !== currentVersion) {
      localStorage.setItem('nurseapp_version', currentVersion);
      window.location.reload(true);
      return;
    }
    localStorage.setItem('nurseapp_version', currentVersion);
  } catch(e) {}
  // ===== 同意チェック（一度同意したらスキップ） =====
  checkConsent();

  // ===== ログイン状態復元（8時間維持） =====
  try {
    var savedStaff = localStorage.getItem('nurseapp_staff');
    var savedTime = localStorage.getItem('nurseapp_login_time');
    var EIGHT_HOURS = 8 * 60 * 60 * 1000;
    if (savedStaff && savedTime && (Date.now() - parseInt(savedTime)) < EIGHT_HOURS) {
      currentStaffInfo = JSON.parse(savedStaff);
      document.getElementById('login-screen').style.display = 'none';
      updateStaffBadge();
    }
  } catch(e) {}

  setTodayDate();
  var rm = document.getElementById('report-month'); if(rm) rm.value = getCurrentMonth();
  loadDocuments('keikaku');
  loadDocuments('hokoku');
  initNursingChat();
  loadMemos();
  document.getElementById('memo-board').style.display = '';
  var today = new Date().toISOString().split('T')[0];
  if (document.getElementById('keikaku-date')) document.getElementById('keikaku-date').value = today;
  loadPatients();
  loadTodaySchedule();

  // ===== 自動ログアウト（無操作30分） =====
  startAutoLogoutTimer();

  // ===== 電波切れ・入力中の自動保存 =====
  startAutoSave();
});
