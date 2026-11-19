import { useState, useEffect, useRef, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import type {
  User,
  VoiceMode,
  VoiceSignalPayload,
  ClientToServerEvents,
  ServerToClientEvents,
} from '../types/watchparty.ts';

export type PeerConnectionStatus = 'connecting' | 'connected' | 'failed';

interface PeerEntry {
  pc: RTCPeerConnection;
  sender: RTCRtpSender | null;
  pendingCandidates: RTCIceCandidateInit[];
  audioEl: HTMLAudioElement | null;
  remoteStream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

interface UseVoiceChatOptions {
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  roomId: string | null;
  currentUserId: string;
  users: Record<string, User>;
  voiceVolumePercent: number; // 0..200
  voiceDuckMultiplier: number; // 0..1 when remote peers speak
  voiceDuckWhenSpeaking?: number; // 0..1 applied if either real or simulated peer is speaking
}

export function useVoiceChat({
  socket,
  roomId,
  currentUserId,
  users,
  voiceVolumePercent,
  voiceDuckMultiplier,
  voiceDuckWhenSpeaking = 1,
}: UseVoiceChatOptions) {
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('text');
  const [isMicOn, setIsMicOn] = useState(false);
  const [isSelfSpeaking, setIsSelfSpeaking] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [hasTurn, setHasTurn] = useState(false);
  const [audioAutoplayBlocked, setAudioAutoplayBlocked] = useState(false);
  const [peerStates, setPeerStates] = useState<Record<string, PeerConnectionStatus>>({});
  const [mutedPeerIds, setMutedPeerIds] = useState<Record<string, boolean>>({});
  const [peerVolumes, setPeerVolumes] = useState<Record<string, number>>({});
  const [isMicTestActive, setIsMicTestActive] = useState(false);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [isMicTestSpeaking, setIsMicTestSpeaking] = useState(false);
  const [isPeerSimActive, setIsPeerSimActive] = useState(false);

  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vadCtxRef = useRef<AudioContext | null>(null);
  const lastSpeakingAtRef = useRef<number>(0);

  // Debug voice test refs
  const micTestStreamRef = useRef<MediaStream | null>(null);
  const micTestSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micTestGainRef = useRef<GainNode | null>(null);
  const micTestDelayRef = useRef<DelayNode | null>(null);
  const micTestIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const micTestLastSpeakRef = useRef<number>(0);

  const simTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const simGainRef = useRef<GainNode | null>(null);
  const simOsc1Ref = useRef<OscillatorNode | null>(null);
  const simOsc2Ref = useRef<OscillatorNode | null>(null);
  const simFilterRef = useRef<BiquadFilterNode | null>(null);

  const voiceModeRef = useRef<VoiceMode>(voiceMode);
  voiceModeRef.current = voiceMode;
  const isMicOnRef = useRef<boolean>(isMicOn);
  isMicOnRef.current = isMicOn;
  const isSelfSpeakingRef = useRef<boolean>(isSelfSpeaking);
  isSelfSpeakingRef.current = isSelfSpeaking;
  const voiceVolumeRef = useRef<number>(voiceVolumePercent);
  voiceVolumeRef.current = voiceVolumePercent;
  const voiceDuckRef = useRef<number>(voiceDuckMultiplier);
  voiceDuckRef.current = voiceDuckMultiplier;
  const mutedPeersRef = useRef<Record<string, boolean>>(mutedPeerIds);
  mutedPeersRef.current = mutedPeerIds;
  const peerVolumesRef = useRef<Record<string, number>>(peerVolumes);
  peerVolumesRef.current = peerVolumes;

  const ensureAudioContext = useCallback(() => {
    if (typeof window === 'undefined') return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;

    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      const ctx = new AudioCtx();
      const master = ctx.createGain();
      const initialMaster = Math.max(0, Math.min(2, (voiceVolumeRef.current / 100) * voiceDuckRef.current));
      master.gain.value = initialMaster;
      master.connect(ctx.destination);
      audioCtxRef.current = ctx;
      masterGainRef.current = master;
    }
    return audioCtxRef.current;
  }, []);

  const unlockVoiceAudio = useCallback(() => {
    const ctx = ensureAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx
        .resume()
        .then(() => {
          setAudioAutoplayBlocked(false);
        })
        .catch(() => {
          setAudioAutoplayBlocked(true);
        });
    } else if (ctx && ctx.state === 'running') {
      setAudioAutoplayBlocked(false);
    }

    peersRef.current.forEach((entry) => {
      if (entry.audioEl && entry.audioEl.paused) {
        entry.audioEl.play().catch(() => {});
      }
    });
  }, [ensureAudioContext]);

  // Global first-gesture unlock so incoming voice chat plays smoothly even before switching to voice tab
  useEffect(() => {
    if (!roomId) return;
    const handleGesture = () => {
      unlockVoiceAudio();
    };
    window.addEventListener('pointerdown', handleGesture, { passive: true });
    window.addEventListener('keydown', handleGesture, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', handleGesture);
      window.removeEventListener('keydown', handleGesture);
    };
  }, [roomId, unlockVoiceAudio]);

  // Fetch STUN / optional TURN config from backend
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    fetch('/api/voice/ice-servers')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          iceServersRef.current = data.iceServers;
          setHasTurn(Boolean(data.hasTurn));
        }
      })
      .catch(() => {
        // Keep public STUN fallback
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Emit state changes only when values actually change
  const emitVoiceState = useCallback(
    (mode: VoiceMode, micOn: boolean, speaking: boolean) => {
      if (!socket || !socket.connected) return;
      socket.emit('voice:state', {
        mode,
        isMicOn: mode === 'voice' && micOn,
        isSpeaking: mode === 'voice' && micOn && speaking,
      });
    },
    [socket]
  );

  // Update master voice gain smoothly when volume or ducking changes
  const effectiveVoiceDuck = isPeerSimActive
    ? Math.min(voiceDuckMultiplier, voiceDuckWhenSpeaking)
    : voiceDuckMultiplier;
  voiceDuckRef.current = effectiveVoiceDuck;

  useEffect(() => {
    const targetMaster = Math.max(0, Math.min(2, (voiceVolumePercent / 100) * effectiveVoiceDuck));
    if (masterGainRef.current && audioCtxRef.current) {
      const now = audioCtxRef.current.currentTime;
      masterGainRef.current.gain.setTargetAtTime(targetMaster, now, 0.06);
    }
    // Fallback for browsers without Web Audio API
    peersRef.current.forEach((entry, peerId) => {
      if (entry.audioEl && !entry.gainNode) {
        const isMuted = Boolean(mutedPeersRef.current[peerId]);
        const peerVol = (peerVolumesRef.current[peerId] ?? 100) / 100;
        entry.audioEl.muted = isMuted;
        entry.audioEl.volume = isMuted ? 0 : Math.max(0, Math.min(1, targetMaster * peerVol));
      }
    });
  }, [voiceVolumePercent, effectiveVoiceDuck]);

  // Apply per-peer mute / volume changes immediately
  useEffect(() => {
    peersRef.current.forEach((entry, peerId) => {
      const isMuted = Boolean(mutedPeerIds[peerId]);
      const peerVol = (peerVolumes[peerId] ?? 100) / 100;
      const gainVal = isMuted ? 0 : Math.max(0, Math.min(2, peerVol));
      if (entry.gainNode && audioCtxRef.current) {
        entry.gainNode.gain.setTargetAtTime(gainVal, audioCtxRef.current.currentTime, 0.03);
      } else if (entry.audioEl) {
        const masterVal = Math.max(0, Math.min(1, (voiceVolumeRef.current / 100) * voiceDuckRef.current));
        entry.audioEl.muted = isMuted;
        entry.audioEl.volume = isMuted ? 0 : Math.max(0, Math.min(1, masterVal * peerVol));
      }
    });
  }, [mutedPeerIds, peerVolumes]);

  const stopMicrophone = useCallback(() => {
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    if (vadCtxRef.current) {
      vadCtxRef.current.close().catch(() => {});
      vadCtxRef.current = null;
    }
    if (localTrackRef.current) {
      localTrackRef.current.onended = null;
      localTrackRef.current.stop();
      localTrackRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    peersRef.current.forEach((entry) => {
      if (entry.sender) {
        entry.sender.replaceTrack(null).catch(() => {});
      }
    });
    setIsMicOn(false);
    setIsSelfSpeaking(false);
    isMicOnRef.current = false;
    isSelfSpeakingRef.current = false;
  }, []);

  const destroyPeer = useCallback((peerId: string) => {
    const entry = peersRef.current.get(peerId);
    if (!entry) return;
    try {
      entry.sourceNode?.disconnect();
      entry.gainNode?.disconnect();
    } catch {}
    if (entry.audioEl) {
      entry.audioEl.pause();
      entry.audioEl.srcObject = null;
      entry.audioEl.remove();
    }
    try {
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.close();
    } catch {}
    peersRef.current.delete(peerId);
    setPeerStates((prev) => {
      if (!prev[peerId]) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  const attachRemoteStream = useCallback(
    (peerId: string, entry: PeerEntry, stream: MediaStream) => {
      if (entry.remoteStream === stream) return;
      entry.remoteStream = stream;

      // Always keep a hidden <audio> attached (muted when WebAudio routes audio) so Chromium pulls WebRTC audio frames
      let audioEl = entry.audioEl;
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.setAttribute('playsinline', 'true');
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        entry.audioEl = audioEl;
      }
      audioEl.srcObject = stream;

      const ctx = ensureAudioContext();
      if (ctx && masterGainRef.current) {
        try {
          entry.sourceNode?.disconnect();
          entry.gainNode?.disconnect();
        } catch {}

        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        const isMuted = Boolean(mutedPeersRef.current[peerId]);
        const peerVol = (peerVolumesRef.current[peerId] ?? 100) / 100;
        gain.gain.value = isMuted ? 0 : Math.max(0, Math.min(2, peerVol));
        source.connect(gain);
        gain.connect(masterGainRef.current);

        entry.sourceNode = source;
        entry.gainNode = gain;

        // Mute the DOM element so we only hear the GainNode-amplified output (0..200%)
        audioEl.muted = true;
        audioEl.play().catch(() => {});
        if (ctx.state === 'suspended') {
          ctx
            .resume()
            .then(() => setAudioAutoplayBlocked(false))
            .catch(() => setAudioAutoplayBlocked(true));
        }
      } else {
        const isMuted = Boolean(mutedPeersRef.current[peerId]);
        const peerVol = (peerVolumesRef.current[peerId] ?? 100) / 100;
        const master = Math.max(0, Math.min(1, (voiceVolumeRef.current / 100) * voiceDuckRef.current));
        audioEl.muted = isMuted;
        audioEl.volume = isMuted ? 0 : Math.max(0, Math.min(1, master * peerVol));
        audioEl.play().catch(() => setAudioAutoplayBlocked(true));
      }
    },
    [ensureAudioContext]
  );

  const createPeerEntry = useCallback(
    (peerId: string): PeerEntry => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({
        iceServers: iceServersRef.current,
      });

      const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      const sender = transceiver.sender;

      if (localTrackRef.current) {
        sender.replaceTrack(localTrackRef.current).catch(() => {});
      }

      const entry: PeerEntry = {
        pc,
        sender,
        pendingCandidates: [],
        audioEl: null,
        remoteStream: null,
        sourceNode: null,
        gainNode: null,
      };
      peersRef.current.set(peerId, entry);

      setPeerStates((prev) => ({ ...prev, [peerId]: 'connecting' }));

      pc.onicecandidate = (event) => {
        if (event.candidate && socket && socket.connected) {
          socket.emit('voice:signal', {
            targetUserId: peerId,
            type: 'ice-candidate',
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (event) => {
        const stream =
          event.streams && event.streams[0]
            ? event.streams[0]
            : new MediaStream([event.track]);
        attachRemoteStream(peerId, entry, stream);
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          setPeerStates((prev) => ({ ...prev, [peerId]: 'connected' }));
        } else if (state === 'failed') {
          setPeerStates((prev) => ({ ...prev, [peerId]: 'failed' }));
        } else if (state === 'connecting' || state === 'new') {
          setPeerStates((prev) => ({ ...prev, [peerId]: 'connecting' }));
        } else if (state === 'closed') {
          setPeerStates((prev) => {
            const next = { ...prev };
            delete next[peerId];
            return next;
          });
        }
      };

      return entry;
    },
    [attachRemoteStream, socket]
  );

  // Reconcile peer connections whenever the room participant list changes
  useEffect(() => {
    if (!roomId || !socket || !currentUserId) return;

    const activePeerIds = new Set(
      Object.keys(users).filter((id) => id && id !== currentUserId)
    );

    // Close removed peers
    for (const existingId of Array.from(peersRef.current.keys())) {
      if (!activePeerIds.has(existingId)) {
        destroyPeer(existingId);
      }
    }

    // Create connections for new peers (deterministic initiator: lower socketId sends offer)
    activePeerIds.forEach((peerId) => {
      if (!peersRef.current.has(peerId)) {
        const entry = createPeerEntry(peerId);
        if (currentUserId < peerId) {
          entry.pc
            .createOffer()
            .then((offer) => entry.pc.setLocalDescription(offer))
            .then(() => {
              if (entry.pc.localDescription && socket.connected) {
                socket.emit('voice:signal', {
                  targetUserId: peerId,
                  type: 'offer',
                  sdp: entry.pc.localDescription.toJSON(),
                });
              }
            })
            .catch(() => {});
        }
      }
    });
  }, [roomId, socket, currentUserId, users, createPeerEntry, destroyPeer]);

  // Listen for incoming WebRTC signaling packets
  useEffect(() => {
    if (!socket || !roomId) return;

    const handleSignal = async (
      payload: VoiceSignalPayload & { fromUserId: string }
    ) => {
      const { fromUserId, type, sdp, candidate } = payload;
      if (!fromUserId || fromUserId === currentUserId) return;

      const entry = createPeerEntry(fromUserId);
      const pc = entry.pc;

      try {
        if (type === 'offer' && sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          for (const queued of entry.pendingCandidates) {
            await pc.addIceCandidate(new RTCIceCandidate(queued)).catch(() => {});
          }
          entry.pendingCandidates = [];

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (pc.localDescription && socket.connected) {
            socket.emit('voice:signal', {
              targetUserId: fromUserId,
              type: 'answer',
              sdp: pc.localDescription.toJSON(),
            });
          }
        } else if (type === 'answer' && sdp) {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            for (const queued of entry.pendingCandidates) {
              await pc.addIceCandidate(new RTCIceCandidate(queued)).catch(() => {});
            }
            entry.pendingCandidates = [];
          }
        } else if (type === 'ice-candidate' && candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
          } else {
            entry.pendingCandidates.push(candidate);
          }
        }
      } catch (err) {
        console.warn('[VoiceChat] Signaling error:', err);
      }
    };

    socket.on('voice:signal', handleSignal);
    return () => {
      socket.off('voice:signal', handleSignal);
    };
  }, [socket, roomId, currentUserId, createPeerEntry]);

  const stopMicTest = useCallback(() => {
    if (micTestIntervalRef.current) {
      clearInterval(micTestIntervalRef.current);
      micTestIntervalRef.current = null;
    }
    try {
      micTestSourceRef.current?.disconnect();
      micTestDelayRef.current?.disconnect();
      micTestGainRef.current?.disconnect();
    } catch {}
    micTestSourceRef.current = null;
    micTestDelayRef.current = null;
    micTestGainRef.current = null;
    if (micTestStreamRef.current) {
      micTestStreamRef.current.getTracks().forEach((t) => t.stop());
      micTestStreamRef.current = null;
    }
    setIsMicTestActive(false);
    setMicTestLevel(0);
    setIsMicTestSpeaking(false);
  }, []);

  const stopPeerSim = useCallback(() => {
    if (simTimerRef.current) {
      clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    try {
      simOsc1Ref.current?.stop();
      simOsc2Ref.current?.stop();
    } catch {}
    try {
      simOsc1Ref.current?.disconnect();
      simOsc2Ref.current?.disconnect();
      simFilterRef.current?.disconnect();
      simGainRef.current?.disconnect();
    } catch {}
    simOsc1Ref.current = null;
    simOsc2Ref.current = null;
    simFilterRef.current = null;
    simGainRef.current = null;
    setIsPeerSimActive(false);
  }, []);

  // Full cleanup when leaving room or unmounting
  useEffect(() => {
    if (roomId) return;
    stopMicrophone();
    stopMicTest();
    stopPeerSim();
    for (const peerId of Array.from(peersRef.current.keys())) {
      destroyPeer(peerId);
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
      masterGainRef.current = null;
    }
    setVoiceMode('text');
    setVoiceError(null);
    setMutedPeerIds({});
    setPeerVolumes({});
  }, [roomId, stopMicrophone, stopMicTest, stopPeerSim, destroyPeer]);

  useEffect(() => {
    return () => {
      stopMicrophone();
      stopMicTest();
      stopPeerSim();
      for (const peerId of Array.from(peersRef.current.keys())) {
        destroyPeer(peerId);
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
        masterGainRef.current = null;
      }
    };
  }, [stopMicrophone, stopMicTest, stopPeerSim, destroyPeer]);

  const startLocalVad = useCallback(
    (stream: MediaStream) => {
      if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
      if (vadCtxRef.current) {
        vadCtxRef.current.close().catch(() => {});
        vadCtxRef.current = null;
      }

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) {
        // Fallback if WebAudio Analyser is unavailable: mark speaking while mic is on
        setIsSelfSpeaking(true);
        isSelfSpeakingRef.current = true;
        emitVoiceState(voiceModeRef.current, true, true);
        return;
      }

      const vadCtx = new AudioCtx();
      vadCtxRef.current = vadCtx;
      if (vadCtx.state === 'suspended') {
        vadCtx.resume().catch(() => {});
      }

      const source = vadCtx.createMediaStreamSource(stream);
      const analyser = vadCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const data = new Uint8Array(analyser.fftSize);
      const SPEAK_THRESHOLD = 0.022;
      const HANG_TIME_MS = 450;

      vadIntervalRef.current = setInterval(() => {
        if (!isMicOnRef.current || voiceModeRef.current !== 'voice') return;
        analyser.getByteTimeDomainData(data);

        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / data.length);
        const now = Date.now();

        if (rms >= SPEAK_THRESHOLD) {
          lastSpeakingAtRef.current = now;
          if (!isSelfSpeakingRef.current) {
            isSelfSpeakingRef.current = true;
            setIsSelfSpeaking(true);
            emitVoiceState('voice', true, true);
          }
        } else if (isSelfSpeakingRef.current && now - lastSpeakingAtRef.current > HANG_TIME_MS) {
          isSelfSpeakingRef.current = false;
          setIsSelfSpeaking(false);
          emitVoiceState('voice', true, false);
        }
      }, 120);
    },
    [emitVoiceState]
  );

  const switchVoiceMode = useCallback(
    (nextMode: VoiceMode) => {
      unlockVoiceAudio();
      setVoiceError(null);

      if (nextMode === 'text') {
        stopMicrophone();
        setVoiceMode('text');
        voiceModeRef.current = 'text';
        emitVoiceState('text', false, false);
      } else {
        // Enter voice mode with mic initially OFF ("Микрофон выключен")
        stopMicrophone();
        setVoiceMode('voice');
        voiceModeRef.current = 'voice';
        emitVoiceState('voice', false, false);
      }
    },
    [unlockVoiceAudio, stopMicrophone, emitVoiceState]
  );

  const toggleMic = useCallback(async () => {
    unlockVoiceAudio();
    setVoiceError(null);

    if (voiceModeRef.current !== 'voice') return;

    if (isMicOnRef.current) {
      stopMicrophone();
      emitVoiceState('voice', false, false);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setVoiceError('Микрофон недоступен в этом браузере (нужен HTTPS). Вы можете слушать других.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        stream.getTracks().forEach((t) => t.stop());
        setVoiceError('Микрофон не найден. Вы можете слушать участников.');
        return;
      }

      // If user already switched back to text mode while permission dialog was open
      if (voiceModeRef.current !== 'voice') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = stream;
      localTrackRef.current = audioTrack;

      audioTrack.onended = () => {
        stopMicrophone();
        emitVoiceState(voiceModeRef.current, false, false);
      };

      for (const entry of peersRef.current.values()) {
        if (entry.sender) {
          await entry.sender.replaceTrack(audioTrack).catch(() => {});
        }
      }

      isMicOnRef.current = true;
      setIsMicOn(true);
      emitVoiceState('voice', true, false);
      startLocalVad(stream);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setVoiceError('Доступ к микрофону запрещён. Вы всё равно слышите собеседников.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setVoiceError('Микрофон не обнаружен. Вы всё равно слышите собеседников.');
      } else {
        setVoiceError('Не удалось включить микрофон. Проверьте разрешения браузера.');
      }
      stopMicrophone();
      emitVoiceState('voice', false, false);
    }
  }, [unlockVoiceAudio, stopMicrophone, emitVoiceState, startLocalVad]);

  const togglePeerMute = useCallback((peerId: string) => {
    setMutedPeerIds((prev) => ({
      ...prev,
      [peerId]: !prev[peerId],
    }));
  }, []);

  const setPeerVolume = useCallback((peerId: string, volumePercent: number) => {
    const clamped = Math.max(0, Math.min(200, Math.round(volumePercent)));
    setPeerVolumes((prev) => ({
      ...prev,
      [peerId]: clamped,
    }));
  }, []);

  const toggleMicTest = useCallback(async () => {
    if (micTestStreamRef.current) {
      stopMicTest();
      return;
    }

    setVoiceError(null);
    unlockVoiceAudio();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setVoiceError('Микрофон недоступен в этом браузере (нужен HTTPS). Для проверки используйте тест собеседника.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      const ctx = ensureAudioContext();
      if (!ctx || !masterGainRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        setVoiceError('Web Audio API недоступен в этом браузере.');
        return;
      }
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }

      const source = ctx.createMediaStreamSource(stream);
      const delay = ctx.createDelay(1.0);
      delay.delayTime.value = 0.18;
      const loopbackGain = ctx.createGain();
      loopbackGain.gain.value = 0.9;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;

      source.connect(analyser);
      source.connect(delay);
      delay.connect(loopbackGain);
      loopbackGain.connect(masterGainRef.current);

      micTestStreamRef.current = stream;
      micTestSourceRef.current = source;
      micTestDelayRef.current = delay;
      micTestGainRef.current = loopbackGain;

      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => stopMicTest();
      }

      const data = new Uint8Array(analyser.fftSize);
      micTestIntervalRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / data.length);
        const level = Math.min(100, Math.round(rms * 420));
        setMicTestLevel(level);

        const now = Date.now();
        if (rms >= 0.022) {
          micTestLastSpeakRef.current = now;
          setIsMicTestSpeaking(true);
        } else if (now - micTestLastSpeakRef.current > 450) {
          setIsMicTestSpeaking(false);
        }
      }, 80);

      setIsMicTestActive(true);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setVoiceError('Нет доступа к микрофону. Проверьте разрешения браузера или используйте тест собеседника.');
      } else {
        setVoiceError('Микрофон не найден. Можно проверить приоритеты кнопкой «Тест собеседника».');
      }
      stopMicTest();
    }
  }, [ensureAudioContext, stopMicTest, unlockVoiceAudio]);

  const togglePeerSim = useCallback(() => {
    if (simOsc1Ref.current) {
      stopPeerSim();
      return;
    }

    unlockVoiceAudio();
    const ctx = ensureAudioContext();
    if (!ctx || !masterGainRef.current) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const simGain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.value = 210;
    osc2.frequency.value = 315;

    filter.type = 'lowpass';
    filter.frequency.value = 680;

    simGain.gain.value = 0.08;

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(simGain);
    simGain.connect(masterGainRef.current);

    osc1.start();
    osc2.start();

    simOsc1Ref.current = osc1;
    simOsc2Ref.current = osc2;
    simFilterRef.current = filter;
    simGainRef.current = simGain;

    // Gentle speech-like cadence pulse so user can clearly hear voice volume (0-200%) & ducking priority
    let step = 0;
    simTimerRef.current = setInterval(() => {
      if (!simGainRef.current || !audioCtxRef.current || !simOsc1Ref.current) return;
      const now = audioCtxRef.current.currentTime;
      const freqs = [205, 240, 220, 195, 255];
      simOsc1Ref.current.frequency.setTargetAtTime(freqs[step % freqs.length], now, 0.05);
      const env = step % 4 === 3 ? 0.015 : 0.095;
      simGainRef.current.gain.setTargetAtTime(env, now, 0.04);
      step++;
    }, 240);

    setIsPeerSimActive(true);
  }, [ensureAudioContext, stopPeerSim, unlockVoiceAudio]);

  return {
    voiceMode,
    isMicOn,
    isSelfSpeaking,
    voiceError,
    hasTurn,
    audioAutoplayBlocked,
    peerStates,
    mutedPeerIds,
    peerVolumes,
    isMicTestActive,
    micTestLevel,
    isMicTestSpeaking,
    isPeerSimActive,
    switchVoiceMode,
    toggleMic,
    togglePeerMute,
    setPeerVolume,
    unlockVoiceAudio,
    toggleMicTest,
    togglePeerSim,
    clearVoiceError: () => setVoiceError(null),
  };
}
