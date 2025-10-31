import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

/* ===== Supabase client ===== */
const supabaseUrl = (window as any).SUPABASE_URL as string;
const supabaseKey = (window as any).SUPABASE_ANON_KEY as string;
const supabase = createClient(supabaseUrl, supabaseKey);

/* ===== Types ===== */
type Room = { id: string; code: string; created_at?: string };
type Player = {
  id: string;
  room_code: string;
  display_name: string;
  total_score: number;
};
type RoundStatus = 'ready' | 'open' | 'closed' | 'scored';
type Round = {
  id: string;
  room_code: string;
  index_no: number;
  status: RoundStatus;
  correct_choice: 'A' | 'B' | 'C' | 'D' | null;
  opened_at?: string | null;
  reveal_started?: boolean | null;
  reveal_at?: string | null;
  created_at?: string;
};
type RankRow = {
  room_code: string;
  round_id: string;
  player_id: string;
  choice: 'A' | 'B' | 'C' | 'D';
  created_at: string;
  elapsed_sec: number | null; // 受付開始からの経過秒
  rank: number;
};

/* ===== Helpers ===== */
const rand4 = () => String(Math.floor(1000 + Math.random() * 9000)); // 4桁数字

/* =======================================================================================
 *                                   共通：部屋状態
 * =======================================================================================
 */
function useRoomCore() {
  const [roomCode, setRoomCode] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [current, setCurrent] = useState<Round | null>(null);
  const [ranks, setRanks] = useState<RankRow[]>([]);

  // Realtime
  useEffect(() => {
    if (!roomCode) return;
    refreshPlayers();
    refreshRounds();

    const ch = supabase
      .channel(`room-${roomCode}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'players',
          filter: `room_code=eq.${roomCode}`,
        },
        () => refreshPlayers()
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rounds',
          filter: `room_code=eq.${roomCode}`,
        },
        () => refreshRounds()
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'answers',
          filter: `room_code=eq.${roomCode}`,
        },
        () => current?.id && refreshRanks(current.id)
      )
      .subscribe();

    return () => void supabase.removeChannel(ch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, current?.id]);

  async function refreshPlayers() {
    if (!roomCode) return;
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .eq('room_code', roomCode)
      .order('created_at', { ascending: true });
    if (error) return console.error(error);
    setPlayers((data || []) as Player[]);
  }

  async function refreshRounds() {
    if (!roomCode) return;
    const { data, error } = await supabase
      .from('rounds')
      .select('*')
      .eq('room_code', roomCode)
      .order('index_no', { ascending: true });
    if (error) return console.error(error);

    const list = (data || []) as Round[];
    setRounds(list);

    setCurrent((prev) => {
      if (!list.length) return null;
      const latest = list[list.length - 1];
      if (!prev) return latest;

      const same = list.find((r) => r.id === prev.id);
      if (!same) return latest;

      // 前問が採点済みで新ラウンドがあれば自動切替
      if (same.status === 'scored' && latest.index_no > same.index_no) {
        return latest;
      }
      return same;
    });

    const cur = list[list.length - 1];
    if (cur?.id) refreshRanks(cur.id);
  }

  async function refreshRanks(roundId: string) {
    const { data, error } = await supabase
      .from('v_round_rank')
      .select('*')
      .eq('round_id', roundId)
      .order('rank', { ascending: true });
    if (error) return console.error(error);
    setRanks((data || []) as RankRow[]);
  }

  function goTopLocalOnly() {
    setRoomCode('');
    setPlayers([]);
    setRounds([]);
    setCurrent(null);
    setRanks([]);
  }

  return {
    roomCode,
    setRoomCode,
    players,
    rounds,
    current,
    setCurrent,
    ranks,
    refreshPlayers,
    refreshRounds,
    refreshRanks,
    goTopLocalOnly,
  };
}

/* =======================================================================================
 *                                   GM ページ
 * =======================================================================================
 */
function GMPage() {
  const [room, setRoom] = useState<Room | null>(null);
  const {
    roomCode,
    setRoomCode,
    players,
    rounds,
    current,
    setCurrent,
    ranks,
    refreshPlayers,
    refreshRounds,
    refreshRanks,
    goTopLocalOnly,
  } = useRoomCore();

  // 配点
  const [w1, setW1] = useState(100);
  const [w2, setW2] = useState(70);
  const [wOther, setWOther] = useState(20);

  // 採点二重防止
  const [isScoring, setIsScoring] = useState(false);

  // ランキング発表（下から）
  const [revealActive, setRevealActive] = useState(false);
  const [revealShown, setRevealShown] = useState(0);
  const revealTimer = useRef<number | null>(null);
  const REVEAL_INTERVAL_MS = 900;

  const correctOnlyRanks = useMemo(() => {
    if (!current?.correct_choice) return [] as RankRow[];
    return ranks.filter((r) => r.choice === current.correct_choice);
  }, [ranks, current?.correct_choice]);

  useEffect(() => {
    // ラウンド変更時は演出リセット
    setRevealActive(false);
    setRevealShown(0);
    if (revealTimer.current) {
      window.clearInterval(revealTimer.current);
      revealTimer.current = null;
    }
  }, [current?.id]);

  function startRevealLocal() {
    if (!correctOnlyRanks.length || revealActive) return;
    setRevealActive(true);
    setRevealShown(1);
    revealTimer.current = window.setInterval(() => {
      setRevealShown((s) => {
        const next = s + 1;
        if (next >= correctOnlyRanks.length) {
          if (revealTimer.current) window.clearInterval(revealTimer.current);
          revealTimer.current = null;
        }
        return Math.min(next, correctOnlyRanks.length);
      });
    }, REVEAL_INTERVAL_MS) as any;
  }

  function showCountFromBottom(): number {
    return revealActive ? revealShown : 0; // ★ GM侧も「開始」までは出さない
  }

  // ルーム作成
  async function createRoom() {
    const code = rand4();
    const { data, error } = await supabase
      .from('rooms')
      .insert({ code })
      .select()
      .single();
    if (error) return alert('ルーム作成エラー: ' + error.message);
    setRoom(data as Room);
    setRoomCode(code);
  }

  // 次 index_no
  async function nextIndexNo(): Promise<number> {
    const { data, error } = await supabase
      .from('rounds')
      .select('index_no')
      .eq('room_code', roomCode)
      .order('index_no', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return data?.length ? data[0].index_no + 1 : 1;
  }

  // 新しい問題
  async function newRound() {
    if (!roomCode) return alert('まずルームを作成してください');
    if (current && current.status !== 'scored') {
      return alert(
        '前の問題が完結していません（締切＆集計 → 正解者に加点 まで実施）'
      );
    }
    const idx = await nextIndexNo();
    const { data, error } = await supabase
      .from('rounds')
      .insert({
        room_code: roomCode,
        status: 'ready',
        index_no: idx,
        reveal_started: false,
        reveal_at: null,
      })
      .select()
      .single();
    if (error) return alert('ラウンド作成エラー: ' + error.message);
    setCurrent(data as Round);
    await refreshRounds();
  }

  // 回答受付開始（opened_at を刻む）
  async function openRound() {
    if (!current) return;
    const { error } = await supabase
      .from('rounds')
      .update({
        status: 'open',
        opened_at: new Date().toISOString(),
        reveal_started: false,
        reveal_at: null,
      })
      .eq('id', current.id);
    if (error) return alert('受付開始エラー: ' + error.message);
    await refreshRounds();
  }

  // 締切
  async function closeRound() {
    if (!current) return;
    const { error } = await supabase
      .from('rounds')
      .update({ status: 'closed' })
      .eq('id', current.id);
    if (error) return alert('締切エラー: ' + error.message);
    await refreshRounds();
  }

  // 正解セット
  async function setCorrect(c: 'A' | 'B' | 'C' | 'D') {
    if (!current) return;
    const { error } = await supabase
      .from('rounds')
      .update({ correct_choice: c })
      .eq('id', current.id);
    if (error) return alert('正解設定エラー: ' + error.message);
    await refreshRounds();
  }

  // 採点（サーバー側で原子的に一発、二重加点不可）
  async function applyScores() {
    if (!current || !current.correct_choice) return;
    if (current.status === 'scored') return;
    if (isScoring) return;

    setIsScoring(true);
    const { error } = await supabase.rpc('apply_scores_for_round', {
      p_round_id: current.id,
      p_first: w1,
      p_second: w2,
      p_other: wOther,
    });
    setIsScoring(false);

    if (error) return alert('加点エラー: ' + error.message);
    await refreshPlayers();
    await refreshRounds(); // status='scored'
  }

  // ★ 発表開始（全端末へ同期：reveal_started=true）
  async function startReveal() {
    if (!current?.correct_choice) return alert('先に正解を選んでください');
    const { error } = await supabase
      .from('rounds')
      .update({ reveal_started: true, reveal_at: new Date().toISOString() })
      .eq('id', current.id);
    if (error) return alert('発表開始エラー: ' + error.message);
    startRevealLocal(); // GM画面でも開始
  }

  // スコアリセット
  async function resetScores() {
    if (!roomCode) return alert('ルームが未設定です');
    if (!confirm('全参加者のスコアを 0 にします。よろしいですか？')) return;
    const { error } = await supabase.rpc('reset_scores', {
      p_room_code: roomCode,
    });
    if (error) return alert('スコアリセットエラー: ' + error.message);
    await refreshPlayers();
  }

  // トップに戻る
  function goTop() {
    try {
      localStorage.removeItem('quiz_me');
    } catch {}
    setRoom(null);
    goTopLocalOnly();
  }

  return (
    <PageWrapper>
      <Header>
        <span>GMページ</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href="/player" style={{ ...btn, textDecoration: 'none' }}>
            👤 参加者ページへ
          </a>
          <button style={btn} onClick={goTop}>
            🏠 トップに戻る
          </button>
        </div>
      </Header>

      {/* 入室 */}
      {!room && (
        <Grid2>
          <Box title="GM：ルーム作成">
            <button style={btnPrimary} onClick={createRoom}>
              新しいルームを作る（4桁数字）
            </button>
            {roomCode && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                作成されたルーム番号: <b>{roomCode}</b>
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: 12, color: '#333' }}>
              ※ パスワード不要。番号を配布してください。
            </div>
          </Box>

          <Box title="（オプション）既存ルームで操作">
            <input
              style={inp}
              placeholder="ルーム番号（4桁数字）"
              value={roomCode}
              onChange={(e) =>
                setRoomCode(e.target.value.replace(/\D/g, '').slice(0, 4))
              }
            />
            <div style={{ fontSize: 12, color: '#333', marginTop: 6 }}>
              ※ 既に作った番号を手で復元したい場合に使用
            </div>
          </Box>
        </Grid2>
      )}

      {/* 参加者 / 履歴 */}
      {roomCode && (
        <Grid2 style={{ marginTop: 12 }}>
          <Box title={`参加者 / 累計スコア（ルーム ${roomCode})`}>
            {players.length === 0 ? (
              <div style={{ fontSize: 12, color: '#333' }}>参加者待ち…</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {players.map((p) => (
                  <li
                    key={p.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      borderBottom: '1px solid #eee',
                      padding: '6px 0',
                    }}
                  >
                    <span>{p.display_name}</span>
                    <b style={{ color: '#111' }}>{p.total_score} pt</b>
                  </li>
                ))}
              </ul>
            )}
          </Box>

          <Box title="ラウンド履歴">
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {rounds.map((r) => (
                <li
                  key={r.id}
                  style={{
                    border: '1px solid #eee',
                    borderRadius: 8,
                    padding: 8,
                    marginBottom: 6,
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    #{r.index_no}{' '}
                    <span style={{ opacity: 0.6 }}>[{r.status}]</span> 正解:
                    {r.correct_choice || '-'} / 発表:
                    {r.reveal_started ? '開始' : '未開始'}
                  </div>
                  {current?.id !== r.id && (
                    <button
                      style={btn}
                      onClick={() => {
                        setCurrent(r);
                        refreshRanks(r.id);
                      }}
                    >
                      このラウンドを見る
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Box>
        </Grid2>
      )}

      {/* 操作パネル */}
      {roomCode && (
        <Grid2 style={{ marginTop: 12 }}>
          <Box title="GM 操作">
            <div style={{ display: 'grid', gap: 8 }}>
              <div>
                現在の問題：
                {current ? `#${current.index_no} [${current.status}]` : 'なし'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!current || current.status === 'scored' ? (
                  <button style={btnPrimary} onClick={newRound}>
                    新しい問題
                  </button>
                ) : null}
                {current && current.status === 'ready' && (
                  <button style={btnBlue} onClick={openRound}>
                    回答受付開始
                  </button>
                )}
                {current && current.status === 'open' && (
                  <button style={btnDanger} onClick={closeRound}>
                    締切＆集計
                  </button>
                )}
              </div>

              {current &&
                (current.status === 'closed' ||
                  current.correct_choice ||
                  current.status === 'scored') && (
                  <div style={panel}>
                    <div>
                      正解を選択：
                      {(['A', 'B', 'C', 'D'] as const).map((c) => (
                        <button
                          key={c}
                          style={{
                            ...btn,
                            ...(current?.correct_choice === c ? btnGreen : {}),
                            marginLeft: 6,
                          }}
                          onClick={() => setCorrect(c)}
                        >
                          {c}
                        </button>
                      ))}
                    </div>

                    <div
                      style={{
                        marginTop: 10,
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span>配点（1位/2位/3位以降）：</span>
                      <input
                        style={inpN}
                        type="number"
                        value={w1}
                        onChange={(e) => setW1(Number(e.target.value))}
                      />
                      <input
                        style={inpN}
                        type="number"
                        value={w2}
                        onChange={(e) => setW2(Number(e.target.value))}
                      />
                      <input
                        style={inpN}
                        type="number"
                        value={wOther}
                        onChange={(e) => setWOther(Number(e.target.value))}
                      />
                    </div>

                    {/* 発表：正解者のみランキング（開始合図が来るまで非表示） */}
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>
                        正解者ランキング発表
                      </div>

                      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                        <button
                          style={btn}
                          onClick={startReveal}
                          disabled={
                            !current?.correct_choice ||
                            !ranks.length ||
                            current?.reveal_started
                          }
                        >
                          🎉 発表を開始（下から）
                        </button>
                        <span style={{ fontSize: 12, color: '#333' }}>
                          {current?.reveal_started
                            ? '※ 発表中'
                            : '※ 押すまで非表示（参加者画面も同時に切替）'}
                        </span>
                      </div>

                      {current?.correct_choice && current?.reveal_started ? (
                        ranks.filter((r) => r.choice === current.correct_choice)
                          .length === 0 ? (
                          <div style={{ fontSize: 12, color: '#333' }}>
                            正解者なし
                          </div>
                        ) : (
                          <ol style={{ paddingLeft: 18, margin: 0 }}>
                            {/** 下から発表：末尾から revealShown 人だけフェードイン */}
                            {ranks
                              .filter(
                                (r) => r.choice === current.correct_choice
                              )
                              .map((r, idx, arr) => {
                                const fromBottomIndex = arr.length - 1 - idx;
                                const visible =
                                  fromBottomIndex < showCountFromBottom();
                                const p = players.find(
                                  (x) => x.id === r.player_id
                                );
                                return (
                                  <li
                                    key={r.player_id}
                                    style={{
                                      opacity: visible ? 1 : 0,
                                      transform: visible
                                        ? 'translateY(0px)'
                                        : 'translateY(10px)',
                                      transition:
                                        'opacity 400ms ease, transform 400ms ease',
                                      padding: '2px 0',
                                    }}
                                  >
                                    {r.rank}位 {p?.display_name}（{r.choice}）
                                    {typeof r.elapsed_sec === 'number'
                                      ? `：${r.elapsed_sec.toFixed(1)} 秒`
                                      : ''}
                                  </li>
                                );
                              })}
                          </ol>
                        )
                      ) : (
                        <div style={{ fontSize: 12, color: '#333' }}>
                          ※ 発表はまだ開始されていません
                        </div>
                      )}
                    </div>

                    <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                      <button
                        style={{
                          ...btn,
                          ...btnGreen,
                          opacity:
                            !current?.correct_choice || isScoring ? 0.6 : 1,
                        }}
                        disabled={
                          !current?.correct_choice ||
                          isScoring ||
                          current?.status === 'scored'
                        }
                        onClick={applyScores}
                      >
                        正解者に加点
                      </button>
                      {current?.status === 'scored' && (
                        <button style={{ ...btn }} onClick={newRound}>
                          次の問題へ
                        </button>
                      )}
                    </div>
                  </div>
                )}

              <div style={{ marginTop: 8 }}>
                <button style={btn} onClick={resetScores}>
                  スコアリセット（GM）
                </button>
              </div>
            </div>
          </Box>

          <Box title="配布用リンク">
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 14 }}>
                参加者は <code>/player</code> にアクセスし、ルーム番号{' '}
                <b>{roomCode || '----'}</b> を入力してください。
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <a href="/gm" style={{ ...btn, textDecoration: 'none' }}>
                  GMページを開く
                </a>
                <a href="/player" style={{ ...btn, textDecoration: 'none' }}>
                  参加者ページを開く
                </a>
              </div>
            </div>
          </Box>
        </Grid2>
      )}
    </PageWrapper>
  );
}

/* =======================================================================================
 *                                   参加者 ページ
 * =======================================================================================
 */
function PlayerPage() {
  const {
    roomCode,
    setRoomCode,
    players,
    current,
    ranks,
    refreshPlayers,
    goTopLocalOnly,
  } = useRoomCore();

  const [myName, setMyName] = useState('');
  const [me, setMe] = useState<Player | null>(null);

  // 自分のこのラウンドでの回答（枠を保持）
  const [myAnswerChoice, setMyAnswerChoice] = useState<
    'A' | 'B' | 'C' | 'D' | null
  >(null);
  const prevRoundId = useRef<string | null>(null);

  // ランキング発表（下から、GMの合図で開始）
  const [revealActive, setRevealActive] = useState(false);
  const [revealShown, setRevealShown] = useState(0);
  const revealTimer = useRef<number | null>(null);
  const REVEAL_INTERVAL_MS = 900;

  // 復元（参加者）
  useEffect(() => {
    const saved = localStorage.getItem('quiz_me');
    if (saved) {
      const p = JSON.parse(saved) as Player;
      setMe(p);
      setMyName(p.display_name);
      setRoomCode(p.room_code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ラウンドが変わったときだけ自分の回答を取り直す（それ以外でクリアしない）
  useEffect(() => {
    const cid = current?.id || null;
    if (cid && prevRoundId.current !== cid) {
      prevRoundId.current = cid;
      setMyAnswerChoice(null); // 新ラウンドでリセット
      (async () => {
        if (!me) return;
        const { data } = await supabase
          .from('answers')
          .select('choice')
          .eq('round_id', cid)
          .eq('player_id', me.id)
          .maybeSingle();
        if (data?.choice) setMyAnswerChoice(data.choice as any);
      })();
    }
  }, [current?.id, me?.id]);

  // GMが発表を開始したら、参加者でも下から自動発表をスタート
  const correctOnlyRanks = useMemo(() => {
    if (!current?.correct_choice) return [] as RankRow[];
    return ranks.filter((r) => r.choice === current.correct_choice);
  }, [ranks, current?.correct_choice]);

  useEffect(() => {
    // 発表状態が切り替わるたびに演出を管理
    if (!current?.reveal_started) {
      setRevealActive(false);
      setRevealShown(0);
      if (revealTimer.current) {
        window.clearInterval(revealTimer.current);
        revealTimer.current = null;
      }
      return;
    }
    // GMが開始した → 参加者側でも開始
    if (!revealActive) {
      setRevealActive(true);
      setRevealShown(1);
      revealTimer.current = window.setInterval(() => {
        setRevealShown((s) => {
          const next = s + 1;
          if (next >= correctOnlyRanks.length) {
            if (revealTimer.current) window.clearInterval(revealTimer.current);
            revealTimer.current = null;
          }
          return Math.min(next, correctOnlyRanks.length);
        });
      }, REVEAL_INTERVAL_MS) as any;
    }
    return () => {
      if (revealTimer.current) window.clearInterval(revealTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.reveal_started]);

  function showCountFromBottom(): number {
    return revealActive ? revealShown : 0; // ★ GMの開始までは非表示
    // （= 参加者画面も発表ボタンが押されるまでは出さない）
  }

  // 参加
  async function joinAsPlayer() {
    if (!roomCode || !/^\d{4}$/.test(roomCode))
      return alert('4桁の数字のルーム番号を入力してください');
    if (!myName.trim()) return alert('名前を入力してください');
    const { data, error } = await supabase
      .from('players')
      .insert({ room_code: roomCode, display_name: myName, total_score: 0 })
      .select()
      .single();
    if (error) return alert('参加エラー: ' + error.message);
    const p = data as Player;
    setMe(p);
    localStorage.setItem('quiz_me', JSON.stringify(p));
    await refreshPlayers();
  }

  // 回答（二度押しは黙って無視／見た目を変えない）
  async function answer(choice: 'A' | 'B' | 'C' | 'D') {
    if (!me) return;
    if (!current || current.status !== 'open') return;

    // すでに押していたら無視（枠を維持）
    if (myAnswerChoice) return;

    const payload = {
      room_code: me.room_code,
      round_id: current.id,
      player_id: me.id,
      choice,
    };
    const { error } = await supabase.from('answers').insert(payload);
    if (error) {
      // 23505 = unique_violation（既に回答あり）なら完全に無視
      // @ts-ignore
      if (error.code === '23505') return;
      return;
    }
    setMyAnswerChoice(choice); // 即時に枠を出す（このラウンド中固定）
  }

  // トップへ
  async function goTop() {
    try {
      localStorage.removeItem('quiz_me');
    } catch {}
    if (me) {
      await supabase.from('players').delete().eq('id', me.id);
    }
    setMe(null);
    setMyName('');
    setRevealActive(false);
    setRevealShown(0);
    goTopLocalOnly();
  }

  const showAnswerColor =
    !!current?.correct_choice &&
    (current.status === 'closed' || current.status === 'scored');

  return (
    <PageWrapper>
      <Header>
        <span>参加者ページ</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href="/gm" style={{ ...btn, textDecoration: 'none' }}>
            🎛️ GMページへ
          </a>
          <button style={btn} onClick={goTop}>
            🏠 トップに戻る
          </button>
        </div>
      </Header>

      {!me && (
        <Grid1>
          <Box title="参加フォーム">
            <div style={{ display: 'grid', gap: 8 }}>
              <input
                style={inp}
                placeholder="ルーム番号（4桁数字）"
                value={roomCode}
                onChange={(e) =>
                  setRoomCode(e.target.value.replace(/\D/g, '').slice(0, 4))
                }
              />
              <input
                style={inp}
                placeholder="表示名"
                value={myName}
                onChange={(e) => setMyName(e.target.value)}
              />
              <button style={btn} onClick={joinAsPlayer}>
                参加
              </button>
            </div>
          </Box>
        </Grid1>
      )}

      {me && current && (
        <Grid1>
          <Box
            title={`問題 #${current.index_no}：${current.status.toUpperCase()}`}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 8,
              }}
            >
              {(['A', 'B', 'C', 'D'] as const).map((c) => {
                const isCorrect =
                  showAnswerColor && current.correct_choice === c;
                const isMine = myAnswerChoice === c;

                // ✅ 毎回 btnBig をクローン（副作用防止）
                let style: React.CSSProperties = {
                  ...btnBig,
                  border: '2px solid #1f2937', // ← デフォルト枠を毎回明示
                  boxShadow: 'none',
                  outline: 'none',
                };

                // ✅ 正解なら赤塗り（borderも赤に上書き）
                if (isCorrect) {
                  style = {
                    ...style,
                    background: '#dc2626',
                    color: '#fff',
                    border: '2px solid #dc2626',
                  };
                }

                // ✅ 自分が押した場合、正誤関係なく太枠リング
                if (isMine) {
                  style = {
                    ...style,
                    boxShadow:
                      '0 0 0 3px rgba(17,24,39,1), 0 0 0 6px rgba(17,24,39,0.15)',
                    outline: 'none',
                  };
                }

                return (
                  <button
                    key={c}
                    onClick={() => answer(c)}
                    disabled={current.status !== 'open'}
                    style={style}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: '#333', marginTop: 6 }}>
              ※ 受付（open）の間のみ回答できます。
            </div>

            {/* ★ 発表はGMが開始するまでは非表示。開始されたら下からゆっくり表示 */}
            {current.reveal_started && current.correct_choice && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>
                  正解者ランキング発表
                </div>
                {ranks.filter((r) => r.choice === current.correct_choice)
                  .length === 0 ? (
                  <div style={{ fontSize: 12, color: '#333' }}>正解者なし</div>
                ) : (
                  <ol style={{ paddingLeft: 18, margin: 0 }}>
                    {ranks
                      .filter((r) => r.choice === current.correct_choice)
                      .map((r, idx, arr) => {
                        const fromBottomIndex = arr.length - 1 - idx;
                        const visible =
                          fromBottomIndex < (revealActive ? revealShown : 0);
                        const p = players.find((x) => x.id === r.player_id);
                        return (
                          <li
                            key={r.player_id}
                            style={{
                              opacity: visible ? 1 : 0,
                              transform: visible
                                ? 'translateY(0px)'
                                : 'translateY(10px)',
                              transition:
                                'opacity 400ms ease, transform 400ms ease',
                              padding: '2px 0',
                            }}
                          >
                            {r.rank}位 {p?.display_name}（{r.choice}）
                            {typeof r.elapsed_sec === 'number'
                              ? `：${r.elapsed_sec.toFixed(1)} 秒`
                              : ''}
                          </li>
                        );
                      })}
                  </ol>
                )}
              </div>
            )}
          </Box>

          <Box title={`参加者 / 累計スコア（ルーム ${roomCode || '-'})`}>
            {players.length === 0 ? (
              <div style={{ fontSize: 12, color: '#333' }}>参加者待ち…</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {players.map((p) => (
                  <li
                    key={p.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      borderBottom: '1px solid #eee',
                      padding: '6px 0',
                    }}
                  >
                    <span>{p.display_name}</span>
                    <b style={{ color: '#111' }}>{p.total_score} pt</b>
                  </li>
                ))}
              </ul>
            )}
          </Box>
        </Grid1>
      )}
    </PageWrapper>
  );
}

/* =======================================================================================
 *                                   ルーティング
 * =======================================================================================
 */
export default function App() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/';
  if (path.startsWith('/gm')) return <GMPage />;
  if (path.startsWith('/player')) return <PlayerPage />;

  return (
    <PageWrapper>
      <Header>
        <span>クイズ ツール</span>
      </Header>
      <Grid2>
        <Box title="GM（司会者）の方はこちら">
          <a
            href="/gm"
            style={{
              ...btnPrimary,
              textDecoration: 'none',
              display: 'inline-block',
            }}
          >
            🎛️ GMページへ
          </a>
          <div style={{ fontSize: 12, color: '#333', marginTop: 8 }}>
            ルーム番号の作成、回答受付の開始/締切、正解設定、発表開始、採点、スコアリセットを行います。
          </div>
        </Box>
        <Box title="参加者の方はこちら">
          <a
            href="/player"
            style={{ ...btn, textDecoration: 'none', display: 'inline-block' }}
          >
            👤 参加者ページへ
          </a>
          <div style={{ fontSize: 12, color: '#333', marginTop: 8 }}>
            司会者から配られたルーム番号と表示名を入力して参加します。
          </div>
        </Box>
      </Grid2>
    </PageWrapper>
  );
}

/* =======================================================================================
 *                                   UI atoms / styles
 * =======================================================================================
 */
const PageWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      minHeight: '100vh',
      background: '#f6f7fb',
      padding: 16,
      color: '#111',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    }}
  >
    <div style={{ maxWidth: 1120, margin: '0 auto' }}>{children}</div>
  </div>
);

const Header: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      margin: '6px 0 14px',
    }}
  >
    <h1 style={{ margin: 0 }}>オールスター風クイズ（決定版）</h1>
    <div style={{ display: 'flex', gap: 8 }}>{children}</div>
  </div>
);

const Grid1: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, ...style }}
  >
    {children}
  </div>
);

const Grid2: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12,
      ...style,
    }}
  >
    {children}
  </div>
);

const Box: React.FC<{ title?: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <div
    style={{
      border: '1px solid #e5e7eb',
      borderRadius: 12,
      padding: 14,
      background: '#ffffff',
      color: '#111',
    }}
  >
    {title && (
      <h2 style={{ margin: '0 0 8px', fontSize: 16, color: '#111' }}>
        {title}
      </h2>
    )}
    {children}
  </div>
);

const btn: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid #1f2937',
  background: '#ffffff',
  color: '#111827',
  cursor: 'pointer',
  fontWeight: 600,
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: '#111827',
  color: '#ffffff',
  borderColor: '#111827',
};
const btnBlue: React.CSSProperties = {
  ...btn,
  background: '#1d4ed8',
  color: '#ffffff',
  borderColor: '#1d4ed8',
};
const btnDanger: React.CSSProperties = {
  ...btn,
  background: '#b91c1c',
  color: '#ffffff',
  borderColor: '#b91c1c',
};
const btnGreen: React.CSSProperties = {
  background: '#047857',
  color: '#ffffff',
  border: '1px solid #047857',
  borderRadius: 10,
  padding: '8px 12px',
  cursor: 'pointer',
  fontWeight: 700,
};
const btnBig: React.CSSProperties = {
  ...btn,
  fontSize: 22,
  padding: '20px 14px',
  borderWidth: 2,
};
const inp: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 10,
  border: '1.5px solid #1f2937',
  color: '#111827',
  background: '#fff',
  fontWeight: 600,
};
const inpN: React.CSSProperties = {
  width: 90,
  padding: '8px 10px',
  borderRadius: 10,
  border: '1.5px solid #1f2937',
  color: '#111827',
};
const panel: React.CSSProperties = {
  background: '#f3f4f6',
  padding: 12,
  borderRadius: 10,
  border: '1px solid #e5e7eb',
};
