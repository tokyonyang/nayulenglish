import Link from 'next/link';

export const metadata = {
  title: '개인정보처리방침 | hohobook',
  description: 'hohobook 개인정보처리방침',
};

export default function PrivacyPage() {
  return (
    <article style={{ maxWidth: 760, margin: '0 auto', padding: '32px 20px 60px', lineHeight: 1.8 }}>
      <h1>hohobook 개인정보처리방침</h1>

      <p>
        hohobook은 영어 그림책 학습을 위한 개인용 서비스이며,
        서비스 제공에 필요한 최소한의 정보만 처리합니다.
      </p>

      <h2>1. 처리하는 정보</h2>
      <p>서비스 이용 과정에서 다음 정보가 처리될 수 있습니다.</p>
      <ul>
        <li>Google OAuth 인증 과정에서 제공되는 계정 식별 정보</li>
        <li>Google OAuth 액세스 토큰 및 리프레시 토큰</li>
        <li>사용자가 hohobook에서 선택하거나 생성한 Google Drive 파일</li>
        <li>사용자가 등록한 책 정보, 학습 기록 및 서비스 이용 데이터</li>
      </ul>

      <h2>2. Google Drive 데이터 접근 범위</h2>
      <p>
        hohobook은 Google Drive API의 <code>drive.file</code> 권한을 사용합니다.
        이 권한은 사용자가 hohobook을 통해 선택하거나 hohobook이 생성한 파일에 접근하기 위한 것입니다.
        사용자의 Google Drive 전체 파일을 임의로 탐색하거나 수집하기 위한 목적으로 사용하지 않습니다.
      </p>

      <h2>3. 정보 이용 목적</h2>
      <ul>
        <li>Google 계정 인증 및 Google Drive 연동</li>
        <li>사용자가 요청한 파일의 저장, 불러오기 및 관리</li>
        <li>영어 그림책 등록, 읽기 및 학습 기록 기능 제공</li>
        <li>서비스 오류 확인 및 기능 유지</li>
      </ul>

      <h2>4. 정보 저장 및 보안</h2>
      <p>
        OAuth 인증 토큰은 Google Drive 연동 기능을 유지하기 위해 서버 환경에 저장될 수 있습니다.
        인증 정보와 서비스 데이터는 서비스 제공에 필요한 범위에서만 사용되며,
        공개 웹페이지에 노출되지 않도록 관리합니다.
      </p>

      <h2>5. 제3자 제공 및 판매</h2>
      <p>
        hohobook은 Google 사용자 데이터를 판매하지 않으며,
        광고 또는 마케팅 목적으로 제3자에게 제공하지 않습니다.
        법령상 의무가 있는 경우를 제외하고 서비스 제공 목적 외로 공유하지 않습니다.
      </p>

      <h2>6. Google API Services User Data Policy 준수</h2>
      <p>
        hohobook의 Google API를 통해 취득한 정보의 사용 및 다른 앱으로의 전송은
        Google API Services User Data Policy 및 Limited Use 요구사항을 준수합니다.
      </p>

      <h2>7. 데이터 삭제 및 권한 철회</h2>
      <p>
        사용자는 Google 계정의 보안 설정에서 언제든지 hohobook의 Google 계정 접근 권한을 철회할 수 있습니다.
        서비스에 저장된 학습 데이터의 삭제가 필요한 경우 서비스 운영자에게 요청할 수 있습니다.
      </p>

      <h2>8. 개인정보처리방침 변경</h2>
      <p>
        서비스 기능 또는 관련 정책이 변경되는 경우 이 개인정보처리방침도 변경될 수 있으며,
        변경된 내용은 이 페이지에 게시합니다.
      </p>

      <h2>9. 문의</h2>
      <p>
        개인정보 및 Google 데이터 처리와 관련한 문의는
        Google OAuth 동의 화면에 등록된 hohobook 개발자 연락처를 통해 요청할 수 있습니다.
      </p>

      <p><strong>시행일: 2026년 10월 1일</strong></p>

      <p style={{ marginTop: 32 }}>
        <Link href="/">← hohobook 홈으로 돌아가기</Link>
      </p>
    </article>
  );
}
