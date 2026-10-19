import { Link, Route, Routes } from 'react-router-dom';
import { CompetitorList } from './pages/CompetitorList';

export function App() {
  return (
    <main className="container">
      <h1>
        <Link to="/" className="brand">
          CompetitorPulse
        </Link>
      </h1>
      <Routes>
        <Route path="/" element={<CompetitorList />} />
        <Route path="*" element={<p>Page not found.</p>} />
      </Routes>
    </main>
  );
}
