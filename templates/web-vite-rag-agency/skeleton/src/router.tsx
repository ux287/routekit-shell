import { Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { Services } from "./pages/Services";
import { Thinking } from "./pages/Thinking";
import { ThinkingDetail } from "./pages/ThinkingDetail";
import { Portfolio } from "./pages/Portfolio";
import { PortfolioDetail } from "./pages/PortfolioDetail";
import { Contact } from "./pages/Contact";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/services" element={<Services />} />
      <Route path="/thinking" element={<Thinking />} />
      <Route path="/thinking/:slug" element={<ThinkingDetail />} />
      <Route path="/portfolio" element={<Portfolio />} />
      <Route path="/portfolio/:slug" element={<PortfolioDetail />} />
      <Route path="/contact" element={<Contact />} />
    </Routes>
  );
}
