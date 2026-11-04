import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CarouselLayout, ConnectionQualityIndicator, GridLayout, LiveKitRoom, ParticipantTile, PreJoin, RoomAudioRenderer, StartAudio,
  TrackToggle, isTrackReference, useChat, useConnectionState, useDataChannel, useLocalParticipant, useParticipants, useRoomContext, useRoomInfo, useTracks,
  type LocalUserChoices,
} from '@livekit/components-react';
import type { ReceivedChatMessage } from '@livekit/components-core';
import { ConnectionState, DisconnectReason, Track, type Participant } from 'livekit-client';
import '@livekit/components-styles';
import {
  AlertCircle, ArrowLeft, Captions, CircleDot, Crown, Hand, Loader2, Lock, LogOut, MessageSquare, MicOff, MoreVertical, PhoneOff, Send,
  ShieldCheck, Square, Unlock, UserX, Users2, VideoOff, WifiOff, X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, cx } from '../components/ui';

/**
 * The live room for an AI Meeting.
 *
 *   pre-join (camera/mic check, consent) -> join API (CRM decides, issues a
 *   10-minute LiveKit token) -> connected room -> left / ended
 *
 * Video and audio go browser-to-LiveKit; this app only ever holds a token for
 * this one person in this one room. LiveKit reconnects on its own after a
 * network drop; the banner says so while it happens.
 */

type Avail = { available: boolean; reason: string | null };
type Capture = { video: Avail; transcript: Avail };
type RoomState = { locked: boolean; recording: boolean; transcribing: boolean; captions: boolean };
type Join = { server_url: string; token: string; is_host: boolean; identity: string; meeting: any; capture?: Capture; state?: Partial<RoomState> };
type Stage = 'prejoin' | 'joining' | 'room' | 'left';

export default function MeetingRoom() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>('prejoin');
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [join, setJoin] = useState<Join | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [deviceNote, setDeviceNote] = useState('');
  const [leftReason, setLeftReason] = useState<DisconnectReason | undefined>();
  // A disconnect before the room ever connected is a failure to connect, not leaving.
  const [everConnected, setEverConnected] = useState(false);
  const [failure, setFailure] = useState('');

  const q = useQuery({ queryKey: ['ai-meetings', 'meeting', id], queryFn: () => api.get<any>(`/ai-meetings/${id}`).then((r) => r.data) });
  const m = q.data;
  const needsConsent = !!(m && (m.recording_allowed || m.transcription_allowed));

  const requestJoin = async (values: LocalUserChoices) => {
    setChoices(values);
    setStage('joining');
    setError('');
    setEverConnected(false);
    try {
      const r = await api.post<Join>(`/ai-meetings/${id}/join`, needsConsent ? { consent: true } : {});
      setJoin(r.data);
      setStage('room');
    } catch (e: any) {
      setStage('prejoin');
      setError(e instanceof ApiError ? e.message : 'Could not reach the server. Check your connection and try again.');
    }
  };

  if (q.isLoading) return <Shell><Loader2 className="animate-spin text-white/70" /></Shell>;
  if (q.isError || !m) {
    return <Shell><Notice title="You cannot open this meeting" body={(q.error as any)?.message || 'It may not exist, or you may not be on it.'} back={`/ai-meetings`} /></Shell>;
  }

  if (stage === 'left') {
    const ended = leftReason === DisconnectReason.ROOM_DELETED;
    const removed = leftReason === DisconnectReason.PARTICIPANT_REMOVED;
    if (!everConnected) {
      return (
        <Shell>
          <Notice
            title="Could not connect to the meeting"
            body={`The video connection did not go through${failure ? ` (${failure})` : ''}. This is usually a network or firewall blocking video traffic. Check your connection and try again.`}
            back={`/ai-meetings/m/${id}`}
            action={<Button variant="primary" onClick={() => { setJoin(null); setFailure(''); setStage('prejoin'); }}>Try again</Button>}
          />
        </Shell>
      );
    }
    return (
      <Shell>
        <Notice
          title={ended ? 'The meeting has ended' : removed ? 'You were removed from the meeting' : 'You left the meeting'}
          body={ended ? 'The host ended it for everyone.' : removed ? 'The host removed you. Ask them if this was a mistake.' : 'You can rejoin while the meeting is still running.'}
          back={`/ai-meetings/m/${id}`}
          action={!ended && !removed && <Button variant="primary" onClick={() => { setJoin(null); setStage('prejoin'); }}>Rejoin</Button>}
        />
      </Shell>
    );
  }

  if (stage === 'room' && join && choices) {
    return (
      <div data-lk-theme="default" className="phx-room h-[100dvh] w-full bg-[#0e1014] text-white">
        <LiveKitRoom
          serverUrl={join.server_url}
          token={join.token}
          connect
          audio={choices.audioEnabled ? { deviceId: choices.audioDeviceId || undefined } : false}
          video={choices.videoEnabled ? { deviceId: choices.videoDeviceId || undefined } : false}
          options={{ adaptiveStream: true, dynacast: true }}
          onConnected={() => setEverConnected(true)}
          onDisconnected={(reason) => { setLeftReason(reason); setStage('left'); }}
          onError={(err) => setFailure(err.message)}
          onMediaDeviceFailure={(_f, kind) => setDeviceNote(kind === 'videoinput'
            ? 'Your camera could not be used. Check the browser permission; you can stay in the meeting without it.'
            : 'Your microphone could not be used. Check the browser permission; others cannot hear you until it works.')}
          className="flex h-full flex-col"
        >
          <RoomView meeting={{ ...m, ...join.meeting }} capture={join.capture} initial={join.state} deviceNote={deviceNote} onDismissNote={() => setDeviceNote('')} />
        </LiveKitRoom>
      </div>
    );
  }

  // ------------------------------------------------------------- pre-join
  const blocked = m.cancelled_at ? 'This meeting was cancelled.' : ['completed', 'ended'].includes(m.status) ? 'This meeting has ended.' : !m.video_ready ? 'Video meetings are not set up yet. An admin needs to add the LiveKit keys.' : '';
  return (
    <div data-lk-theme="default" className="phx-room min-h-[100dvh] w-full bg-[#0e1014] text-white">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
        <button type="button" onClick={() => navigate(`/ai-meetings/m/${id}`)} className="inline-flex items-center gap-1 text-[13px] text-white/60 hover:text-white cursor-pointer w-fit">
          <ArrowLeft size={14} /> Back to the meeting
        </button>
        <div>
          <h1 className="text-[22px] font-semibold">{m.title}</h1>
          <p className="text-[13px] text-white/60">Hosted by {m.host_name} · Check your camera and microphone, then join.</p>
        </div>
        {blocked ? <div className="rounded-lg bg-white/5 p-4 text-[14px] text-white/80 flex gap-2"><AlertCircle size={16} className="mt-0.5 shrink-0" />{blocked}</div> : (
          <>
            {needsConsent && (
              <label className="flex items-start gap-2.5 rounded-lg border border-white/15 bg-white/5 p-3 text-[13.5px] cursor-pointer">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#4ccf85]" checked={consent} onChange={(e) => setConsent(e.target.checked)}
                  aria-label="I agree to this meeting being recorded or transcribed" />
                <span>
                  <span className="flex items-center gap-1.5 font-medium"><ShieldCheck size={15} /> This meeting may be {[m.recording_allowed && 'recorded', m.transcription_allowed && 'transcribed'].filter(Boolean).join(' and ')}</span>
                  <span className="block text-white/60 mt-0.5">Only the host can start it, and everyone sees an indicator while it runs. Transcripts are used for the AI summary and proposed tasks, which a manager reviews. I agree to this.</span>
                </span>
              </label>
            )}
            {error && <div className="rounded-lg bg-red-500/15 px-3 py-2 text-[13.5px] text-red-200 flex gap-2" role="alert"><AlertCircle size={16} className="mt-0.5 shrink-0" />{error}</div>}
            {deviceNote && <div className="rounded-lg bg-amber-500/15 px-3 py-2 text-[13px] text-amber-100">{deviceNote}</div>}
            <div className={cx('phx-prejoin', stage === 'joining' && 'pointer-events-none opacity-60')}>
              <PreJoin
                defaults={{ username: user?.name || '', videoEnabled: true, audioEnabled: true }}
                persistUserChoices
                joinLabel={stage === 'joining' ? 'Joining…' : 'Join meeting'}
                micLabel="Microphone"
                camLabel="Camera"
                userLabel="Your name"
                onValidate={() => !needsConsent || consent}
                onSubmit={(v) => requestJoin({ ...v, username: user?.name || v.username })}
                onError={(err) => setDeviceNote(/denied|notallowed|permission/i.test(`${err.name} ${err.message}`)
                  ? 'Camera or microphone access was blocked. Allow it from the icon in the address bar, or join with them off.'
                  : `Your camera or microphone is not available (${err.message}). You can still join with them off.`)}
              />
            </div>
            {needsConsent && !consent && <p className="text-[12.5px] text-white/50">Tick the agreement above to enable Join.</p>}
          </>
        )}
      </div>
    </div>
  );
}

// ================================================================== the room
const HAND = 'hand';

function meta(p: Participant): any {
  try { return p.metadata ? JSON.parse(p.metadata) : {}; } catch { return {}; }
}
const handRaised = (p: Participant) => !!p.attributes?.[HAND];

/** Who is host right now: the participant whose metadata says so (it follows a hand-over), else the meeting's host. */
function hostIdentity(participants: Participant[], fallback: string) {
  return participants.find((p) => meta(p).role === 'host')?.identity || fallback;
}

type Panel = '' | 'people' | 'chat';

function RoomView({ meeting, capture, initial, deviceNote, onDismissNote }: {
  meeting: any; capture?: Capture; initial?: Partial<RoomState>; deviceNote: string; onDismissNote: () => void;
}) {
  const [panel, setPanel] = useState<Panel>('');
  const [notice, setNotice] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Lock, recording and captions are published in the room's metadata, so every client (and a new host)
  // sees the current value. A host's own change shows at once, until the room confirms it.
  const { metadata: roomMeta } = useRoomInfo();
  const [override, setOverride] = useState<Partial<RoomState>>({});
  useEffect(() => { setOverride({}); }, [roomMeta]);
  const live: RoomState = useMemo(() => {
    const fromRoom: Partial<RoomState> = {};
    try {
      const md = JSON.parse(roomMeta || '{}');
      for (const k of ['locked', 'recording', 'transcribing', 'captions'] as const) if (typeof md[k] === 'boolean') fromRoom[k] = md[k];
    } catch { /* not ours yet */ }
    return { locked: !!meeting.locked, recording: false, transcribing: false, captions: false, ...initial, ...fromRoom, ...override };
  }, [roomMeta, override, initial, meeting.locked]);
  const locked = live.locked;
  const capturing = live.recording || live.transcribing;
  const [showCaptions, setShowCaptions] = useState(true);
  const [captionNote, setCaptionNote] = useState('');
  const connection = useConnectionState();
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const hostId = hostIdentity(participants, meeting.host_id);
  const amHost = localParticipant.identity === hostId;

  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }, { source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: false },
  );
  const screen = tracks.find((t) => t.source === Track.Source.ScreenShare && isTrackReference(t));
  const cameras = tracks.filter((t) => t.source === Track.Source.Camera);

  // ----- chat: LiveKit's data channel (encrypted in transit), with an unread count while the panel is closed
  const { chatMessages, send, isSending } = useChat();
  const [seen, setSeen] = useState(0);
  useEffect(() => { if (panel === 'chat') setSeen(chatMessages.length); }, [panel, chatMessages.length]);
  const unread = panel === 'chat' ? 0 : chatMessages.slice(seen).filter((msg) => msg.from?.identity !== localParticipant.identity).length;

  // ----- raise hand: a participant attribute everyone can see; the host is told
  const raised = handRaised(localParticipant);
  const toggleHand = () => localParticipant.setAttributes({ [HAND]: raised ? '' : String(Date.now()) }).catch(() => setNotice('Could not raise your hand. Try again.'));
  const hands = participants.filter(handRaised);
  const [handCount, setHandCount] = useState(0);
  useEffect(() => {
    if (amHost && hands.length > handCount) {
      const newest = [...hands].sort((a, b) => Number(b.attributes[HAND]) - Number(a.attributes[HAND]))[0];
      if (newest && !newest.isLocal) setNotice(`${newest.name || 'Someone'} raised their hand`);
    }
    setHandCount(hands.length);
  }, [hands.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- host controls go through the CRM, which checks the caller is the host
  const host = async (action: string, body: any, done?: string) => {
    try {
      await api.post(`/ai-meetings/${meeting.id}/host/${action}`, body);
      if (done) setNotice(done);
      return true;
    } catch (e: any) { setNotice(e?.message || 'That did not go through'); return false; }
  };

  // ----- recording: everyone is told when it starts or stops
  const wasCapturing = useRef(capturing);
  useEffect(() => {
    if (wasCapturing.current !== capturing) {
      setNotice(capturing ? (live.recording ? 'Recording started' : 'Transcription started') : 'Recording stopped');
      wasCapturing.current = capturing;
    }
  }, [capturing]); // eslint-disable-line react-hooks/exhaustive-deps
  const post = async (path: string, body: any) => {
    try { return (await api.post<any>(`/ai-meetings/${meeting.id}/${path}`, body)).data; } catch (e: any) { setNotice(e?.message || 'That did not go through'); return null; }
  };
  const setCapture = async (start: boolean) => {
    const r = await post(`capture/${start ? 'start' : 'stop'}`, {});
    if (!r) return;
    setOverride((o) => ({ ...o, recording: r.recording, transcribing: r.transcribing }));
    if (r.video_failed) setNotice('The video recorder could not start; the transcript is still being captured.');
  };
  const toggleCaptions = async (on: boolean) => {
    const r = await post('captions', { on });
    if (r) setOverride((o) => ({ ...o, captions: r.captions }));
  };

  const [started] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const elapsed = Math.floor((Date.now() - started) / 1000);
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(t); }, [notice]);

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-white/10">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-semibold">{meeting.title}</p>
          <p className="text-[12px] text-white/50">
            {clock} · {participants.length} in the meeting{amHost ? ' · You are the host' : ''}{locked ? ' · Locked' : ''}
          </p>
        </div>
        {capturing && (
          <span role="status" className="inline-flex items-center gap-1.5 rounded-full bg-red-500/20 px-2.5 py-1 text-[12px] font-medium text-red-100">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden /> {live.recording ? 'Recording' : 'Transcribing'}
          </span>
        )}
        {hands.length > 0 && (
          <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-amber-400/20 px-2.5 py-1 text-[12px] text-amber-100">
            <Hand size={13} /> {hands.length} hand{hands.length > 1 ? 's' : ''} up
          </span>
        )}
        <ConnectionBadge state={connection} />
        {amHost && (
          <HostMenu locked={locked} meeting={meeting} capture={capture} live={live}
            onLock={async (v) => { if (await host('lock', { locked: v }, v ? 'Meeting locked: nobody new can join.' : 'Meeting unlocked.')) setOverride((o) => ({ ...o, locked: v })); }}
            onCapture={setCapture} onCaptions={toggleCaptions} onEnd={() => setConfirmEnd(true)} />
        )}
      </header>

      {connection === ConnectionState.Reconnecting && (
        <div className="flex items-center gap-2 bg-amber-500/20 px-4 py-2 text-[13px] text-amber-100" role="status">
          <WifiOff size={15} /> Connection lost. Reconnecting… your camera and microphone resume automatically.
        </div>
      )}
      {deviceNote && (
        <div className="flex items-center gap-2 bg-amber-500/15 px-4 py-2 text-[13px] text-amber-100" role="status">
          <AlertCircle size={15} /> <span className="flex-1">{deviceNote}</span>
          <button type="button" aria-label="Dismiss" onClick={onDismissNote} className="cursor-pointer p-1"><X size={14} /></button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 p-2 sm:p-3">
          {screen ? (
            <div className="flex h-full flex-col gap-2 lg:flex-row">
              <div className="min-h-0 flex-1 rounded-xl overflow-hidden bg-black">
                <ParticipantTile trackRef={screen} className="h-full" />
              </div>
              <div className="h-28 lg:h-auto lg:w-56 shrink-0">
                <CarouselLayout tracks={cameras} orientation="vertical" className="h-full">
                  <ParticipantTile />
                </CarouselLayout>
              </div>
            </div>
          ) : (
            <GridLayout tracks={cameras} className="h-full">
              <ParticipantTile />
            </GridLayout>
          )}
        </main>
        {panel === 'people' && (
          <PeoplePanel hostId={hostId} amHost={amHost} onClose={() => setPanel('')}
            onMute={(p) => host('mute', { identity: p.identity }, `${p.name} has been muted.`)}
            onRemove={(p) => host('remove', { identity: p.identity }, `${p.name} was removed and cannot rejoin this meeting.`)}
            onLowerHand={(p) => host('lower-hand', { identity: p.identity })}
            onMakeHost={(p) => host('transfer', { user_id: p.identity }, `${p.name} is now the host.`)} />
        )}
        {panel === 'chat' && <ChatPanel messages={chatMessages} send={send} sending={isSending} me={localParticipant.identity} onClose={() => setPanel('')} />}
        <LiveCaptions on={live.captions} visible={showCaptions} onProblem={setCaptionNote} />
        {notice && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-[13px] shadow-lg" role="status">{notice}</div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-center gap-2 border-t border-white/10 px-3 py-3">
        <TrackToggle source={Track.Source.Microphone} className="phx-ctl" showIcon>
          <span className="hidden md:inline">Microphone</span>
        </TrackToggle>
        <TrackToggle source={Track.Source.Camera} className="phx-ctl" showIcon>
          <span className="hidden md:inline">Camera</span>
        </TrackToggle>
        <TrackToggle source={Track.Source.ScreenShare} className="phx-ctl" showIcon captureOptions={{ audio: true, selfBrowserSurface: 'exclude' }}
          onDeviceError={() => setNotice('Screen sharing was cancelled or is not allowed in this browser.')}>
          <span className="hidden md:inline">{localParticipant.isScreenShareEnabled ? 'Stop sharing' : 'Share screen'}</span>
        </TrackToggle>
        <button type="button" onClick={toggleHand} aria-pressed={raised} className={cx('phx-ctl', raised && 'phx-ctl-hand')}>
          <Hand size={18} /> <span className="hidden md:inline">{raised ? 'Lower hand' : 'Raise hand'}</span>
        </button>
        <button type="button" onClick={() => setPanel(panel === 'chat' ? '' : 'chat')} aria-pressed={panel === 'chat'}
          aria-label={unread ? `Chat, ${unread} unread` : 'Chat'} className={cx('phx-ctl relative', panel === 'chat' && 'phx-ctl-on')}>
          <MessageSquare size={18} /> <span className="hidden md:inline">Chat</span>
          {unread > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-[#4ccf85] px-1 text-[11px] font-semibold text-[#0e1014]">{unread}</span>}
        </button>
        <button type="button" onClick={() => setPanel(panel === 'people' ? '' : 'people')} aria-pressed={panel === 'people'}
          className={cx('phx-ctl', panel === 'people' && 'phx-ctl-on')}>
          <Users2 size={18} /> <span className="hidden md:inline">People</span> <span className="text-white/60">{participants.length}</span>
        </button>
        {live.captions && (
          <button type="button" onClick={() => setShowCaptions((v) => !v)} aria-pressed={showCaptions} className={cx('phx-ctl', showCaptions && 'phx-ctl-on')}>
            <Captions size={18} /> <span className="hidden md:inline">Captions</span>
          </button>
        )}
        <LeaveButton />
        {live.captions && captionNote && <p className="basis-full text-center text-[12px] text-amber-100/80">{captionNote}</p>}
      </footer>
      <RoomAudioRenderer />
      <StartAudio label="Click to allow meeting audio" className="phx-startaudio" />

      {confirmEnd && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/60 px-4" role="dialog" aria-modal="true" aria-label="End the meeting for everyone">
          <div className="w-full max-w-sm rounded-xl bg-[#1a1f27] p-5">
            <p className="text-[16px] font-semibold">End the meeting for everyone?</p>
            <p className="mt-1.5 text-[13.5px] text-white/60">Everyone is disconnected and the meeting is marked as ended. It cannot be rejoined.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="phx-ctl" onClick={() => setConfirmEnd(false)}>Cancel</button>
              <button type="button" className="phx-ctl phx-leave" onClick={async () => { setConfirmEnd(false); await host('end', {}); }}>End for everyone</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function HostMenu({ locked, meeting, capture, live, onLock, onCapture, onCaptions, onEnd }: {
  locked: boolean; meeting: any; capture?: Capture; live: RoomState;
  onLock: (v: boolean) => void; onCapture: (start: boolean) => void; onCaptions: (on: boolean) => void; onEnd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const capturing = live.recording || live.transcribing;
  const mayCapture = meeting.recording_allowed || meeting.transcription_allowed;
  const canVideo = !!capture?.video.available;
  const canTranscript = !!capture?.transcript.available;
  const why = (meeting.recording_allowed && capture?.video.reason) || (meeting.transcription_allowed && capture?.transcript.reason) || '';
  return (
    <div className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[12.5px] hover:bg-white/15 cursor-pointer">
        <Crown size={13} /> Host controls
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-2 w-72 overflow-hidden rounded-lg border border-white/10 bg-[#1a1f27] shadow-xl">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onLock(!locked); }}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13.5px] hover:bg-white/5 cursor-pointer">
            {locked ? <Unlock size={15} /> : <Lock size={15} />} {locked ? 'Unlock the meeting' : 'Lock the meeting'}
            <span className="ml-auto text-[11px] text-white/40">{locked ? 'locked' : ''}</span>
          </button>
          {mayCapture && (capturing ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onCapture(false); }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13.5px] hover:bg-white/5 cursor-pointer">
              <Square size={15} className="text-red-300" /> Stop recording
            </button>
          ) : (
            <button type="button" role="menuitem" disabled={!canVideo && !canTranscript} onClick={() => { setOpen(false); onCapture(true); }}
              className="flex w-full items-start gap-2 px-3 py-2.5 text-left text-[13.5px] hover:bg-white/5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60">
              <CircleDot size={15} className="mt-0.5 text-red-400" />
              <span>
                {canVideo || (meeting.recording_allowed && !canTranscript) ? 'Start recording' : 'Start transcript'}
                <span className="block text-[11.5px] text-white/50">
                  {!canVideo && !canTranscript ? why
                    : [canVideo && 'Video', canTranscript && (canVideo ? 'a transcript of who said what' : 'A transcript of who said what')].filter(Boolean).join(' and ') + '. Everyone sees that it is on.'}
                </span>
              </span>
            </button>
          ))}
          {meeting.transcription_allowed && (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onCaptions(!live.captions); }}
              className="flex w-full items-start gap-2 px-3 py-2.5 text-left text-[13.5px] hover:bg-white/5 cursor-pointer">
              <Captions size={15} className="mt-0.5" />
              <span>
                {live.captions ? 'Turn off live captions' : 'Turn on live captions'}
                <span className="block text-[11.5px] text-white/50">Each speaker's browser turns their speech into text. Not saved.</span>
              </span>
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onEnd(); }}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13.5px] text-red-300 hover:bg-white/5 cursor-pointer">
            <PhoneOff size={15} /> End meeting for everyone
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- live captions
/**
 * Live captions: each person's own browser turns their own speech into text
 * (Web Speech API; in Chrome and Edge that is the browser's speech service)
 * and sends the words to the room over the data channel. Nothing is stored,
 * a muted microphone is never captioned, and each viewer can hide them.
 */
type CaptionLine = { name: string; text: string; at: number };

function LiveCaptions({ on, visible, onProblem }: { on: boolean; visible: boolean; onProblem: (note: string) => void }) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const [lines, setLines] = useState<Record<string, CaptionLine>>({});
  const put = (id: string, name: string, text: string) => setLines((l) => ({ ...l, [id]: { name, text, at: Date.now() } }));
  const { send } = useDataChannel('captions', (msg) => {
    try {
      const d = JSON.parse(new TextDecoder().decode(msg.payload));
      if (typeof d.text === 'string' && msg.from) put(msg.from.identity, msg.from.name || 'Someone', d.text.slice(0, 300));
    } catch { /* not a caption */ }
  });
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!on || !isMicrophoneEnabled) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { onProblem('Your browser cannot caption your speech. Use Chrome or Edge for that; you still see everyone else\'s captions.'); return; }
    onProblem('');
    let stopped = false;
    let lastSent = 0;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-IN';
    rec.onresult = (e: any) => {
      let text = '';
      let final = false;
      for (let i = e.resultIndex; i < e.results.length; i++) { text += e.results[i][0].transcript; final = e.results[i].isFinal; }
      text = text.trim();
      if (!text) return;
      put(localParticipant.identity, 'You', text);
      const now = Date.now();
      if (final || now - lastSent > 350) {
        lastSent = now;
        sendRef.current(new TextEncoder().encode(JSON.stringify({ text, final })), { reliable: final }).catch(() => {});
      }
    };
    rec.onerror = (e: any) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
        stopped = true;
        onProblem('Your speech cannot be captioned: the browser blocked its speech service or microphone.');
      }
    };
    rec.onend = () => { if (!stopped) setTimeout(() => { if (!stopped) { try { rec.start(); } catch { /* already running */ } } }, 300); };
    try { rec.start(); } catch { /* already running */ }
    return () => { stopped = true; try { rec.abort(); } catch { /* gone */ } };
  }, [on, isMicrophoneEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const [, tick] = useState(0);
  useEffect(() => { if (!on) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [on]);
  if (!on || !visible) return null;
  const recent = Object.entries(lines).filter(([, l]) => Date.now() - l.at < 6000).sort((a, b) => a[1].at - b[1].at).slice(-3);
  return (
    <div aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
      {recent.length > 0 && (
        <div className="max-w-3xl space-y-0.5 rounded-lg bg-black/75 px-4 py-2 text-[15px] leading-snug">
          {recent.map(([id, l]) => <p key={id}><span className="font-semibold text-[#8ee0b2]">{l.name}:</span> {l.text.slice(-160)}</p>)}
        </div>
      )}
    </div>
  );
}

function LeaveButton() {
  const room = useRoomSafe();
  return (
    <button type="button" className="phx-ctl phx-leave" onClick={() => room?.disconnect()}>
      <PhoneOff size={18} /> <span className="hidden md:inline">Leave</span>
    </button>
  );
}

function useRoomSafe() {
  try { return useRoomContext(); } catch { return null; }
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const map: Record<string, [string, string]> = {
    [ConnectionState.Connected]: ['Connected', 'bg-emerald-500/20 text-emerald-200'],
    [ConnectionState.Connecting]: ['Connecting…', 'bg-white/10 text-white/70'],
    [ConnectionState.Reconnecting]: ['Reconnecting…', 'bg-amber-500/20 text-amber-100'],
    [ConnectionState.SignalReconnecting]: ['Reconnecting…', 'bg-amber-500/20 text-amber-100'],
    [ConnectionState.Disconnected]: ['Disconnected', 'bg-red-500/20 text-red-200'],
  };
  const [label, cls] = map[state] || [state, 'bg-white/10'];
  return <span className={cx('hidden sm:inline rounded-full px-2.5 py-1 text-[12px] font-medium', cls)}>{label}</span>;
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <aside className="flex w-full max-w-[340px] flex-col border-l border-white/10 bg-[#161a20] max-sm:absolute max-sm:inset-y-0 max-sm:right-0 max-sm:z-10">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <p className="text-[14px] font-semibold">{title}</p>
        <button type="button" aria-label={`Close ${title}`} onClick={onClose} className="cursor-pointer p-1 text-white/60 hover:text-white"><X size={16} /></button>
      </div>
      {children}
    </aside>
  );
}

function PeoplePanel({ hostId, amHost, onClose, onMute, onRemove, onLowerHand, onMakeHost }: {
  hostId: string; amHost: boolean; onClose: () => void;
  onMute: (p: Participant) => void; onRemove: (p: Participant) => void; onLowerHand: (p: Participant) => void; onMakeHost: (p: Participant) => void;
}) {
  const participants = useParticipants();
  const [menu, setMenu] = useState('');
  // Raised hands first (oldest first), then the host, then everyone by name.
  const sorted = useMemo(() => [...participants].sort((a, b) => {
    const ha = Number(a.attributes?.[HAND] || 0); const hb = Number(b.attributes?.[HAND] || 0);
    if (!!ha !== !!hb) return ha ? -1 : 1;
    if (ha && hb) return ha - hb;
    return Number(b.identity === hostId) - Number(a.identity === hostId) || (a.name || '').localeCompare(b.name || '');
  }), [participants, hostId]);
  return (
    <Panel title={`People (${participants.length})`} onClose={onClose}>
      <ul className="flex-1 overflow-y-auto">
        {sorted.map((p) => {
          const md = meta(p);
          const others = amHost && !p.isLocal;
          return (
            <li key={p.identity} className="relative flex items-center gap-2.5 px-4 py-2.5">
              <span className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-[12px] font-semibold', p.isSpeaking && 'ring-2 ring-[#4ccf85]')}>
                {(p.name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13.5px] truncate">
                  {p.name || p.identity}{p.isLocal && <span className="text-white/50">(you)</span>}
                  {p.identity === hostId && <span className="inline-flex items-center gap-0.5 rounded bg-[#4ccf85]/20 px-1.5 text-[11px] text-[#8ee0b2]"><Crown size={10} />Host</span>}
                </span>
                <span className="block text-[11.5px] text-white/50 truncate">{[md.designation, md.department].filter(Boolean).join(' · ')}</span>
              </span>
              {handRaised(p) && <Hand size={15} className="text-amber-300" aria-label="Hand raised" />}
              {!p.isMicrophoneEnabled && <MicOff size={14} className="text-white/50" aria-label="Microphone off" />}
              {!p.isCameraEnabled && <VideoOff size={14} className="text-white/50" aria-label="Camera off" />}
              <ConnectionQualityIndicator participant={p} className="phx-quality" />
              {others && (
                <button type="button" aria-label={`Host actions for ${p.name}`} onClick={() => setMenu(menu === p.identity ? '' : p.identity)}
                  className="cursor-pointer rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"><MoreVertical size={15} /></button>
              )}
              {others && menu === p.identity && (
                <div role="menu" className="absolute right-3 top-11 z-20 w-48 overflow-hidden rounded-lg border border-white/10 bg-[#1d2229] shadow-xl">
                  {p.isMicrophoneEnabled && <MenuItem onClick={() => { setMenu(''); onMute(p); }} icon={<MicOff size={14} />}>Mute microphone</MenuItem>}
                  {handRaised(p) && <MenuItem onClick={() => { setMenu(''); onLowerHand(p); }} icon={<Hand size={14} />}>Lower hand</MenuItem>}
                  <MenuItem onClick={() => { setMenu(''); onMakeHost(p); }} icon={<Crown size={14} />}>Make host</MenuItem>
                  <MenuItem danger onClick={() => { setMenu(''); onRemove(p); }} icon={<UserX size={14} />}>Remove from meeting</MenuItem>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function MenuItem({ children, icon, onClick, danger }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
      className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-white/5 cursor-pointer', danger && 'text-red-300')}>
      {icon}{children}
    </button>
  );
}

function ChatPanel({ messages, send, sending, me, onClose }: {
  messages: ReceivedChatMessage[]; send: (m: string) => Promise<unknown>; sending: boolean; me: string; onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setError('');
    try { await send(t); setText(''); } catch { setError('Not sent. Check your connection and try again.'); }
  };
  return (
    <Panel title="Meeting chat" onClose={onClose}>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {!messages.length && <p className="text-[13px] text-white/50">Messages here are seen by everyone in the meeting while it runs.</p>}
        {messages.map((msg) => {
          const mine = msg.from?.identity === me;
          return (
            <div key={msg.id} className={cx('max-w-[90%]', mine && 'ml-auto text-right')}>
              <p className="text-[11.5px] text-white/50">
                {mine ? 'You' : msg.from?.name || 'Someone'} · {new Date(msg.timestamp).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
              </p>
              <p className={cx('mt-0.5 inline-block whitespace-pre-wrap break-words rounded-lg px-3 py-1.5 text-left text-[13.5px]', mine ? 'bg-[#4ccf85]/25' : 'bg-white/10')}>{msg.message}</p>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {error && <p className="px-4 text-[12.5px] text-red-300">{error}</p>}
      <form className="flex gap-2 border-t border-white/10 p-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="Send a message"
          aria-label="Message" className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 text-[13.5px] text-white outline-none placeholder:text-white/40 focus:ring-2 focus:ring-[#4ccf85]/60" />
        <button type="submit" disabled={sending || !text.trim()} className="phx-ctl disabled:opacity-50" aria-label="Send message"><Send size={16} /></button>
      </form>
    </Panel>
  );
}

// ------------------------------------------------------------------ chrome
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-[100dvh] place-items-center bg-[#0e1014] px-4 text-white">{children}</div>;
}

function Notice({ title, body, back, action }: { title: string; body: string; back: string; action?: React.ReactNode }) {
  return (
    <div className="max-w-md text-center">
      <LogOut className="mx-auto mb-3 text-white/40" />
      <h1 className="text-[20px] font-semibold">{title}</h1>
      <p className="mt-1.5 text-[14px] text-white/60">{body}</p>
      <div className="mt-5 flex justify-center gap-2">
        {action}
        <Link to={back}><Button>Back to the meeting</Button></Link>
      </div>
    </div>
  );
}
