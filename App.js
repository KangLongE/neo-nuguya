import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const TOPICS = ['잡담', '게임', '개발', '학교', '고민', '취미', '음악', '아무거나'];
const REPORT_REASONS = ['부적절한 대화', '개인정보 요구', '괴롭힘', '스팸', '기타'];
const SERVER_URL = (process.env.EXPO_PUBLIC_SERVER_URL
  || (Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000'))
  .replace(/\/$/, '');
const SOCKET_URL = SERVER_URL.replace(/^http/, 'ws');

export default function App() {
  const socketRef = useRef(null);
  const reconnectRef = useRef(null);
  const noticeRef = useRef(null);
  const cooldownRef = useRef(null);
  const listRef = useRef(null);
  const messageId = useRef(0);
  const [screen, setScreen] = useState('rules');
  const [connection, setConnection] = useState('연결 중');
  const [topic, setTopic] = useState(null);
  const [partnerStatus, setPartnerStatus] = useState('정상');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [coolingDown, setCoolingDown] = useState(false);
  const [notice, setNotice] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('');

  const showNotice = useCallback((text) => {
    setNotice(text);
    clearTimeout(noticeRef.current);
    noticeRef.current = setTimeout(() => setNotice(''), 3_000);
  }, []);

  const startCooldown = useCallback((duration = 1_500) => {
    setCoolingDown(true);
    clearTimeout(cooldownRef.current);
    cooldownRef.current = setTimeout(() => setCoolingDown(false), duration);
  }, []);

  useEffect(() => {
    let active = true;
    let token;

    async function connect() {
      if (!active) return;
      setConnection('연결 중');
      try {
        if (!token) {
          const response = await fetch(`${SERVER_URL}/session`, { method: 'POST' });
          if (!response.ok) throw new Error('session');
          token = (await response.json()).token;
        }
        const socket = new WebSocket(`${SOCKET_URL}/socket?token=${encodeURIComponent(token)}`);
        socketRef.current = socket;

        socket.onopen = () => active && setConnection('연결됨');
        socket.onmessage = ({ data }) => {
          if (!active) return;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            return;
          }
          if (event.type === 'waiting') {
            setTopic(event.topic);
            setScreen('waiting');
          } else if (event.type === 'matched') {
            setTopic(event.topic);
            setPartnerStatus(event.partnerStatus);
            setMessages([{ id: ++messageId.current, kind: 'system', text: '연결됐어요. 가볍게 인사해 보세요.' }]);
            setScreen('chat');
          } else if (event.type === 'message') {
            setMessages((current) => [...current, {
              id: ++messageId.current,
              kind: event.own ? 'own' : 'partner',
              text: event.text,
            }]);
            if (event.own) startCooldown();
          } else if (event.type === 'error') {
            showNotice(event.message);
            if (event.retryAfter) startCooldown(event.retryAfter);
          } else if (event.type === 'ended' || event.type === 'reported') {
            setScreen('topics');
            setMessages([]);
            showNotice(event.message);
          }
        };
        socket.onclose = ({ code }) => {
          if (!active) return;
          if (code === 1008) token = null;
          setConnection('연결 끊김');
          setScreen((current) => {
            if (current === 'waiting' || current === 'chat') {
              showNotice('연결이 끊겼어요. 주제를 다시 선택해 주세요.');
              return 'topics';
            }
            return current;
          });
          reconnectRef.current = setTimeout(connect, 1_500);
        };
        socket.onerror = () => {};
      } catch {
        setConnection('연결 끊김');
        reconnectRef.current = setTimeout(connect, 1_500);
      }
    }

    connect();
    return () => {
      active = false;
      clearTimeout(reconnectRef.current);
      clearTimeout(noticeRef.current);
      clearTimeout(cooldownRef.current);
      socketRef.current?.close();
    };
  }, [showNotice, startCooldown]);

  function emit(payload) {
    if (socketRef.current?.readyState !== 1) {
      showNotice('서버에 다시 연결하고 있어요.');
      return false;
    }
    socketRef.current.send(JSON.stringify(payload));
    return true;
  }

  function chooseTopic(selected) {
    if (!emit({ type: 'queue', topic: selected })) return;
    setTopic(selected);
    setScreen('waiting');
  }

  function leaveChat() {
    emit({ type: 'leave' });
    setMessages([]);
    setScreen('topics');
  }

  function sendMessage() {
    const text = draft.trim();
    if (!text || coolingDown || !emit({ type: 'message', text })) return;
    setDraft('');
  }

  function submitReport() {
    if (!reportReason) return;
    emit({ type: 'report', reason: reportReason });
    setReportReason('');
    setReportOpen(false);
  }

  const connected = connection === '연결됨';

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#F5F5F2" />
      <View style={[styles.app, Platform.OS === 'android' && styles.androidTop]}>
        <View style={styles.header}>
          <Text style={styles.brand}>neo nuguya</Text>
          <View style={styles.connectionRow}>
            <View style={[styles.connectionMark, connected && styles.connectionMarkOn]} />
            <Text style={styles.connectionText}>{connection}</Text>
          </View>
        </View>

        {notice ? <Text style={styles.notice} accessibilityLiveRegion="polite">{notice}</Text> : null}

        {screen === 'rules' && (
          <View style={styles.screen}>
            <Text style={styles.label}>처음 오셨나요?</Text>
            <Text style={styles.title}>누구인지 말고,{`\n`}무슨 얘기인지.</Text>
            <Text style={styles.description}>이름도 프로필도 필요 없어요. 서로를 존중하는 세 가지만 확인해 주세요.</Text>
            <View style={styles.ruleBox}>
              {[
                '개인정보와 연락처는 나누지 않기',
                '괴롭힘과 불쾌한 표현은 멈추기',
                '불편하면 설명 없이 바로 나가기',
              ].map((rule, index) => (
                <View key={rule} style={[styles.ruleRow, index === 2 && styles.lastRow]}>
                  <Text style={styles.ruleNumber}>{String(index + 1).padStart(2, '0')}</Text>
                  <Text style={styles.ruleText}>{rule}</Text>
                </View>
              ))}
            </View>
            <View style={styles.spacer} />
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
              onPress={() => setScreen('topics')}
            >
              <Text style={styles.primaryButtonText}>확인하고 시작하기</Text>
            </Pressable>
            <Text style={styles.footnote}>대화는 영구 저장하지 않아요.</Text>
          </View>
        )}

        {screen === 'topics' && (
          <View style={styles.screen}>
            <Text style={styles.label}>대화 주제</Text>
            <Text style={styles.title}>어떤 이야기가{`\n`}끌리나요?</Text>
            <Text style={styles.description}>하나를 고르면 같은 주제를 선택한 사람을 찾아드려요.</Text>
            <View style={styles.topicGrid}>
              {TOPICS.map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="button"
                  accessibilityLabel={`${item} 주제 선택`}
                  style={({ pressed }) => [styles.topicButton, pressed && styles.topicPressed]}
                  onPress={() => chooseTopic(item)}
                >
                  <Text style={styles.topicText}>{item}</Text>
                  <Text style={styles.topicArrow}>→</Text>
                </Pressable>
              ))}
            </View>
            <Pressable accessibilityRole="button" onPress={() => setScreen('rules')} style={styles.linkButton}>
              <Text style={styles.linkText}>안전수칙 다시 보기</Text>
            </Pressable>
          </View>
        )}

        {screen === 'waiting' && (
          <View style={[styles.screen, styles.centeredScreen]}>
            <View style={styles.waitingMark}><Text style={styles.waitingMarkText}>?</Text></View>
            <Text style={[styles.title, styles.centerText]}>대화 상대를{`\n`}찾고 있어요.</Text>
            <Text style={[styles.description, styles.centerText]}>같은 주제의 누군가가 들어오면 바로 연결할게요.</Text>
            <View style={styles.selectedTopic}>
              <Text style={styles.selectedTopicLabel}>선택한 주제</Text>
              <Text style={styles.selectedTopicText}>{topic}</Text>
            </View>
            <View style={styles.spacer} />
            <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={leaveChat}>
              <Text style={styles.secondaryButtonText}>매칭 취소</Text>
            </Pressable>
          </View>
        )}

        {screen === 'chat' && (
          <KeyboardAvoidingView style={styles.chat} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.chatHeader}>
              <View>
                <Text style={styles.chatPartner}>낯선 사람</Text>
                <Text style={styles.chatTopic}>{topic}</Text>
              </View>
              <View style={styles.chatActions}>
                <Pressable accessibilityRole="button" onPress={() => setReportOpen(true)} style={styles.smallButton}>
                  <Text style={styles.smallButtonText}>신고</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={leaveChat} style={styles.smallButton}>
                  <Text style={styles.smallButtonText}>나가기</Text>
                </Pressable>
              </View>
            </View>
            {partnerStatus !== '정상' && (
              <Text style={styles.warning}>
                {partnerStatus === '제한'
                  ? '최근 여러 차례 채팅 규칙을 위반한 사용자예요.'
                  : '최근 채팅에서 주의를 받은 사용자예요.'}
              </Text>
            )}
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(item) => String(item.id)}
              contentContainerStyle={styles.messageList}
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
              renderItem={({ item }) => (
                <View style={[
                  styles.message,
                  item.kind === 'own' && styles.ownMessage,
                  item.kind === 'system' && styles.systemMessage,
                ]}>
                  <Text style={[
                    styles.messageText,
                    item.kind === 'own' && styles.ownMessageText,
                    item.kind === 'system' && styles.systemMessageText,
                  ]}>{item.text}</Text>
                </View>
              )}
            />
            <View style={styles.composer}>
              <TextInput
                accessibilityLabel="메시지"
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="메시지를 입력하세요"
                placeholderTextColor="#8B8B86"
                maxLength={250}
                multiline
              />
              <View style={styles.composerBottom}>
                <Text style={styles.counter}>{[...draft].length} / 250</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="메시지 보내기"
                  disabled={!draft.trim() || coolingDown || !connected}
                  onPress={sendMessage}
                  style={[styles.sendButton, (!draft.trim() || coolingDown || !connected) && styles.disabledButton]}
                >
                  <Text style={styles.sendButtonText}>{coolingDown ? '잠시' : '전송'}</Text>
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        )}
      </View>

      <Modal visible={reportOpen} transparent animationType="none" onRequestClose={() => setReportOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet} accessibilityViewIsModal>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>신고 사유</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="신고 닫기" onPress={() => setReportOpen(false)}>
                <Text style={styles.modalClose}>닫기</Text>
              </Pressable>
            </View>
            <Text style={styles.modalDescription}>신고하면 대화가 바로 종료돼요.</Text>
            {REPORT_REASONS.map((reason) => (
              <Pressable
                key={reason}
                accessibilityRole="radio"
                accessibilityState={{ checked: reportReason === reason }}
                onPress={() => setReportReason(reason)}
                style={[styles.reasonButton, reportReason === reason && styles.reasonSelected]}
              >
                <Text style={[styles.reasonText, reportReason === reason && styles.reasonSelectedText]}>{reason}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              disabled={!reportReason}
              onPress={submitReport}
              style={[styles.primaryButton, styles.reportSubmit, !reportReason && styles.disabledButton]}
            >
              <Text style={styles.primaryButtonText}>신고하고 대화 종료</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F5F5F2' },
  app: { flex: 1, backgroundColor: '#F5F5F2' },
  androidTop: { paddingTop: StatusBar.currentHeight || 24 },
  header: {
    height: 58,
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#D8D8D2',
  },
  brand: { color: '#111111', fontSize: 16, fontWeight: '800', letterSpacing: -0.5 },
  connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  connectionMark: { width: 8, height: 8, backgroundColor: '#A1A19B' },
  connectionMarkOn: { backgroundColor: '#111111' },
  connectionText: { color: '#666660', fontSize: 12, fontWeight: '600' },
  notice: {
    marginHorizontal: 18,
    marginTop: 12,
    padding: 12,
    color: '#111111',
    backgroundColor: '#E3E3DE',
    borderWidth: 1,
    borderColor: '#C8C8C2',
    fontSize: 13,
  },
  screen: { flex: 1, paddingHorizontal: 24, paddingTop: 36, paddingBottom: 20 },
  label: { color: '#666660', fontSize: 12, fontWeight: '700', marginBottom: 14 },
  title: { color: '#111111', fontSize: 38, lineHeight: 45, fontWeight: '800', letterSpacing: -1.5 },
  description: { color: '#666660', fontSize: 15, lineHeight: 23, marginTop: 16, marginBottom: 28 },
  ruleBox: { borderWidth: 1, borderColor: '#C8C8C2', backgroundColor: '#FFFFFF' },
  ruleRow: {
    minHeight: 54,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#D8D8D2',
  },
  lastRow: { borderBottomWidth: 0 },
  ruleNumber: { width: 34, color: '#777771', fontSize: 11, fontWeight: '700' },
  ruleText: { flex: 1, color: '#111111', fontSize: 14, fontWeight: '600' },
  spacer: { flex: 1 },
  primaryButton: {
    minHeight: 56,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111111',
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  pressed: { backgroundColor: '#333330' },
  footnote: { color: '#777771', fontSize: 11, textAlign: 'center', marginTop: 14 },
  topicGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  topicButton: {
    width: '48.5%',
    minHeight: 66,
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#C8C8C2',
  },
  topicPressed: { backgroundColor: '#E3E3DE', borderColor: '#111111' },
  topicText: { color: '#111111', fontSize: 15, fontWeight: '700' },
  topicArrow: { color: '#666660', fontSize: 18 },
  linkButton: { alignSelf: 'center', marginTop: 20, padding: 10 },
  linkText: { color: '#666660', fontSize: 12, textDecorationLine: 'underline' },
  centeredScreen: { alignItems: 'center', paddingTop: 72 },
  waitingMark: {
    width: 92,
    height: 92,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#111111',
    marginBottom: 32,
  },
  waitingMarkText: { color: '#111111', fontSize: 36, fontWeight: '800' },
  centerText: { textAlign: 'center' },
  selectedTopic: {
    width: '100%',
    padding: 17,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#E3E3DE',
    borderWidth: 1,
    borderColor: '#C8C8C2',
  },
  selectedTopicLabel: { color: '#666660', fontSize: 12 },
  selectedTopicText: { color: '#111111', fontSize: 15, fontWeight: '800' },
  secondaryButton: {
    width: '100%',
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#111111',
  },
  secondaryButtonText: { color: '#111111', fontSize: 15, fontWeight: '800' },
  chat: { flex: 1 },
  chatHeader: {
    minHeight: 66,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#D8D8D2',
  },
  chatPartner: { color: '#111111', fontSize: 15, fontWeight: '800' },
  chatTopic: { color: '#666660', fontSize: 11, marginTop: 2 },
  chatActions: { flexDirection: 'row', gap: 8 },
  smallButton: { paddingHorizontal: 11, paddingVertical: 9, borderWidth: 1, borderColor: '#C8C8C2' },
  smallButtonText: { color: '#333330', fontSize: 12, fontWeight: '700' },
  warning: {
    marginHorizontal: 14,
    marginTop: 10,
    padding: 10,
    color: '#111111',
    backgroundColor: '#E3E3DE',
    borderWidth: 1,
    borderColor: '#C8C8C2',
    fontSize: 12,
  },
  messageList: { flexGrow: 1, justifyContent: 'flex-end', padding: 16, gap: 8 },
  message: {
    maxWidth: '78%',
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: '#E3E3DE',
    borderWidth: 1,
    borderColor: '#D0D0CA',
  },
  ownMessage: { alignSelf: 'flex-end', backgroundColor: '#111111', borderColor: '#111111' },
  systemMessage: { alignSelf: 'center', backgroundColor: 'transparent', borderWidth: 0 },
  messageText: { color: '#111111', fontSize: 14, lineHeight: 21 },
  ownMessageText: { color: '#FFFFFF' },
  systemMessageText: { color: '#777771', fontSize: 11, textAlign: 'center' },
  composer: { margin: 12, padding: 12, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#C8C8C2' },
  input: { minHeight: 48, maxHeight: 110, color: '#111111', fontSize: 15, textAlignVertical: 'top' },
  composerBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  counter: { color: '#777771', fontSize: 11 },
  sendButton: { minWidth: 70, minHeight: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111111' },
  sendButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  disabledButton: { opacity: 0.35 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  modalSheet: { padding: 24, paddingBottom: 32, backgroundColor: '#F5F5F2', borderTopWidth: 1, borderTopColor: '#111111' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { color: '#111111', fontSize: 26, fontWeight: '800', letterSpacing: -0.8 },
  modalClose: { color: '#555550', fontSize: 13, textDecorationLine: 'underline', padding: 8 },
  modalDescription: { color: '#666660', fontSize: 13, marginTop: 8, marginBottom: 20 },
  reasonButton: { minHeight: 48, paddingHorizontal: 14, justifyContent: 'center', borderWidth: 1, borderColor: '#C8C8C2', marginBottom: 8 },
  reasonSelected: { backgroundColor: '#111111', borderColor: '#111111' },
  reasonText: { color: '#111111', fontSize: 14, fontWeight: '600' },
  reasonSelectedText: { color: '#FFFFFF' },
  reportSubmit: { marginTop: 14 },
});
