import { useEffect, useRef, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '@app-types/chat'
import CodeBlock from './CodeBlock'
import ThinkingIndicator from './ThinkingIndicator'
import '@styles/chat.css'

const SCROLL_THRESHOLD = 150 // px — 이 이내면 "맨 아래"로 간주

function checkIsNearBottom(el: HTMLDivElement | null): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD
}

interface ChatPanelProps {
  messages: ChatMessage[]
  isStreaming: boolean
  sshConnected?: boolean
  onRunCommand?: (command: string) => void
}

export default function ChatPanel({ messages, isStreaming, sshConnected, onRunCommand }: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)      // 사용자가 위로 스크롤했는가
  const prevMessageCountRef = useRef(0)        // 새 메시지 감지용

  // ── 사용자 스크롤 감지 ────────────────────────────────────────
  // wheel 이벤트로 감지: scrollIntoView 애니메이션과 혼동 불가
  // (scroll 이벤트는 프로그래밍 스크롤과 사용자 스크롤 구분 불가 → 사용하지 않음)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // 사용자가 위로 스크롤 → 자동스크롤 잠금
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // 위로 스크롤 → 즉시 잠금
        userScrolledUpRef.current = true
      } else if (e.deltaY > 0) {
        // 아래로 스크롤 → 스크롤 적용 후 하단 도달 시 잠금 해제
        requestAnimationFrame(() => {
          if (checkIsNearBottom(el)) {
            userScrolledUpRef.current = false
          }
        })
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: true })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // ── Smart Auto-Scroll ─────────────────────────────────────────
  useEffect(() => {
    const count = messages.length
    const prev = prevMessageCountRef.current
    prevMessageCountRef.current = count

    // 사용자가 새 메시지 전송 시 (count 증가 + 마지막-1이 user) → 무조건 스크롤
    const userJustSent =
      count >= 2 && count > prev && messages[count - 2]?.role === 'user'

    if (userJustSent) {
      userScrolledUpRef.current = false
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      return
    }

    // 스트리밍 업데이트: 사용자가 위로 스크롤한 상태면 스크롤 안 함
    if (!userScrolledUpRef.current) {
      // 즉시 스크롤 (smooth 아님) — 80ms마다 호출되므로 애니메이션 중첩 방지
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const markdownComponents = useMemo(() => ({
    code({ className, children, ...props }: { className?: string; children?: React.ReactNode; [key: string]: unknown }) {
      const match = /language-(\w+)/.exec(className || '')
      const codeStr = String(children).replace(/\n$/, '')

      // 블록 코드: 언어 태그 있거나 멀티라인 → CodeBlock (Run 버튼 + 안전 검사)
      // 인라인 코드: 단일 줄 + 언어 태그 없음 → 일반 <code>
      const isBlock = match !== null || codeStr.includes('\n')

      if (isBlock) {
        return (
          <CodeBlock
            language={match ? match[1] : ''}
            code={codeStr}
            sshConnected={sshConnected}
            onRunCommand={onRunCommand}
          />
        )
      }

      return (
        <code className="inline-code" {...props}>
          {children}
        </code>
      )
    },
  }), [sshConnected, onRunCommand])

  return (
    <div className="chat-panel" ref={scrollRef}>
      {messages.length === 0 ? (
        <div className="chat-empty-state">
          <span className="chat-empty-icon">💬</span>
          <p>메시지를 입력하거나 <strong>AI분석</strong> 버튼을 눌러보세요.</p>
        </div>
      ) : (
        <>
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-bubble ${msg.role}`}>
              {msg.role === 'user' ? (
                <div className="chat-bubble-content">{msg.content}</div>
              ) : (
                <div className="chat-bubble-content">
                  {msg.isStreaming && !msg.content ? (
                    <ThinkingIndicator />
                  ) : (
                    <>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {msg.content || ' '}
                      </ReactMarkdown>
                      {msg.isStreaming && <span className="streaming-cursor" />}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </>
      )}
    </div>
  )
}
