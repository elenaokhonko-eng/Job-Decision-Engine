import React, { useState, useEffect } from "react";
import {
  Briefcase,
  Search,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Cpu,
  Database,
  RefreshCw,
  Plus,
  Terminal,
  ArrowRight,
  TrendingUp,
  MapPin,
  Shield,
  Award,
  Zap,
  Info,
  ChevronRight,
  Sparkles,
  Globe,
  Mail,
  Activity,
  Flame,
  Filter,
  Sliders,
  Maximize2
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// Conforming to our updated Postgres-simulated schema
interface Job {
  id: string;
  title: string;
  company: string;
  source: "LinkedIn" | "MyCareersFuture" | "eFinancialCareers" | "Gmail";
  description: string;
  salaryRange?: string;
  postedDate?: string;
  location?: string;
  careers_portal_url: string; // Mandatory careers link for verification
  
  // Evaluation results cached in DB
  status?: "UNASSIGNED" | "STRONG MATCH" | "REVIEW REQUIRED" | "REJECTED";
  assigned_track?: "Track A - Finance/AI" | "Track B - Pharma/Research" | "Neither";
  confidence_level?: "High" | "Medium" | "Low";
  total_score?: number;
  
  score_technical_autonomy?: number;
  score_compensation_potential?: number;
  score_domain_relevance?: number;
  score_environment_guardrails?: number;
  score_future_mobility?: number;

  nd_friendly_score?: number;
  politics_stress_score?: number;
  sensory_overload_index?: number;
  is_toxic?: boolean;
  is_nd_approved?: boolean;
  biological_stress_risk?: string;
  strategic_value?: string;
  recommended_cv_version?: string;
  next_action?: string;
}

interface ScoreItem {
  score: number;
  rationale: string;
}

interface EvaluatedJob {
  job_id?: string;
  job_title: string;
  company: string;
  careers_portal_url: string;
  assigned_track: "Track A - Finance/AI" | "Track B - Pharma/Research" | "Neither";
  status: "STRONG MATCH" | "REVIEW REQUIRED" | "REJECTED";
  total_score: number;
  confidence_level: "High" | "Medium" | "Low";
  score_breakdown: {
    technical_autonomy: ScoreItem;
    compensation_potential: ScoreItem;
    domain_relevance: ScoreItem;
    environment_guardrails: ScoreItem;
    future_mobility: ScoreItem;
  };
  nd_friendly_score: number;
  politics_stress_score: number;
  sensory_overload_index: number;
  hard_disqualifiers_triggered: string[];
  biological_and_stress_risk_assessment: string;
  strategic_value: string;
  recommended_cv_version: string;
  next_action: string;
}

interface AgentResponse {
  evaluation_summary?: string;
  evaluated_jobs: EvaluatedJob[];
}

interface Interaction {
  id: string;
  timestamp: string;
  question: string;
  toolsUsed: string[];
  answer: AgentResponse;
  trace: string[];
}

interface CompanyAnalytics {
  company: string;
  industry: string;
  careers_portal_url: string;
  nd_friendly_score: number;
  politics_stress_score: number;
  sensory_overload_index: number;
  avg_match_score: number;
  jobs_count: number;
  is_nd_approved: boolean;
  is_toxic: boolean;
}

interface AnalyticsPayload {
  ndApproved: CompanyAnalytics[];
  toxicBlacklist: CompanyAnalytics[];
  allCompaniesCount: number;
}

export default function App() {
  // Core Application State
  const [jobs, setJobs] = useState<Job[]>([]);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search and Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<string>("ALL");
  const [selectedTrackFilter, setSelectedTrackFilter] = useState<string>("ALL");

  // Navigation Panel Tab (Vault & Decisions vs ND Culture Analytics)
  const [activeTab, setActiveTab] = useState<"vault" | "analytics">("vault");

  // Custom Raw Job Input Form State
  const [customTitle, setCustomTitle] = useState("");
  const [customCompany, setCustomCompany] = useState("");
  const [customSource, setCustomSource] = useState<Job["source"]>("LinkedIn");
  const [customDescription, setCustomDescription] = useState("");
  const [customSalary, setCustomSalary] = useState("");
  const [customLocation, setCustomLocation] = useState("");
  const [customCareersUrl, setCustomCareersUrl] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  // Crawler Agents Configurations & Sync State
  const [agentConfig, setAgentConfig] = useState({
    linkedin: true,
    mycareersfuture: true,
    efinancialcareers: true,
    gmail: false
  });
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncLogs, setSyncLogs] = useState<string[]>([]);
  const [showAgentHub, setShowAgentHub] = useState(false);

  // Dynamic Culture Analytics State
  const [analytics, setAnalytics] = useState<AnalyticsPayload>({
    ndApproved: [],
    toxicBlacklist: [],
    allCompaniesCount: 0
  });

  // Active Evaluated Result State
  const [activeQuestion, setActiveQuestion] = useState("");
  const [evaluationResult, setEvaluationResult] = useState<AgentResponse | null>(null);
  const [agentTrace, setAgentTrace] = useState<string[]>([]);
  const [agentToolsUsed, setAgentToolsUsed] = useState<string[]>([]);

  // UI Selection State
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  // Initialize Data
  useEffect(() => {
    fetchJobs();
    fetchInteractions();
    fetchAnalytics();
  }, []);

  const fetchJobs = async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = await res.json();
      if (data.success) {
        setJobs(data.jobs);
        if (data.jobs.length > 0 && !selectedJob) {
          setSelectedJob(data.jobs[0]);
        }
      }
    } catch (err) {
      console.error("Failed to load jobs from Postgres vault", err);
    }
  };

  const fetchInteractions = async () => {
    try {
      const res = await fetch("/api/interactions");
      const data = await res.json();
      if (data.success) {
        setInteractions(data.interactions);
      }
    } catch (err) {
      console.error("Failed to load audit trace history", err);
    }
  };

  const fetchAnalytics = async () => {
    try {
      const res = await fetch("/api/analytics");
      const data = await res.json();
      if (data.success && data.analytics) {
        setAnalytics(data.analytics);
      }
    } catch (err) {
      console.error("Failed to aggregate ND culture statistics", err);
    }
  };

  const handleAskAgent = async (question: string) => {
    setLoading(true);
    setError(null);
    setEvaluationResult(null);
    setAgentTrace([]);
    setAgentToolsUsed([]);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question })
      });
      const data = await res.json();
      if (data.success) {
        setEvaluationResult(data.result);
        setAgentTrace(data.trace || []);
        setAgentToolsUsed(data.toolsUsed || []);
        
        // Refresh local database caches
        await fetchJobs();
        await fetchInteractions();
        await fetchAnalytics();
      } else {
        setError(data.error || "An error occurred during evaluation.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to communicate with the decision backend.");
    } finally {
      setLoading(false);
    }
  };

  const handleEvaluateSelectedJob = () => {
    if (!selectedJob) return;
    const prompt = `Evaluate this job description in the database: "${selectedJob.title}" at "${selectedJob.company}". The complete job description is: ${selectedJob.description}. Salary info: ${selectedJob.salaryRange || "Not specified"}. Location: ${selectedJob.location || "Not specified"}. Real careers verification URL is "${selectedJob.careers_portal_url}".`;
    setActiveQuestion(`Evaluate: ${selectedJob.title} at ${selectedJob.company}`);
    handleAskAgent(prompt);
  };

  const handleAddCustomJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customTitle || !customCompany || !customDescription) {
      alert("Please fill in Job Title, Company, and Raw Description.");
      return;
    }

    // Default careers page if empty
    const portalUrl = customCareersUrl.trim() || `https://www.${customCompany.toLowerCase().replace(/[^a-z0-9]/g, "")}.com/careers`;

    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: customTitle,
          company: customCompany,
          source: customSource,
          description: customDescription,
          salaryRange: customSalary,
          location: customLocation,
          careers_portal_url: portalUrl
        })
      });
      const data = await res.json();
      if (data.success) {
        await fetchJobs();
        await fetchAnalytics();
        setSelectedJob(data.job);
        
        // Reset Custom Fields
        setCustomTitle("");
        setCustomCompany("");
        setCustomDescription("");
        setCustomSalary("");
        setCustomLocation("");
        setCustomCareersUrl("");
        setShowAddForm(false);
      } else {
        alert(data.error || "Failed to insert job posting.");
      }
    } catch (err) {
      console.error("Error creating custom job", err);
    }
  };

  const handleSyncAgents = async () => {
    setSyncLoading(true);
    setSyncLogs([]);
    try {
      const res = await fetch("/api/sync-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(agentConfig)
      });
      const data = await res.json();
      if (data.success) {
        setSyncLogs(data.logs || []);
        await fetchJobs();
        await fetchAnalytics();
      } else {
        setSyncLogs(["[ERROR] Source sync agents encountered a failure: " + (data.error || "Unknown network error")]);
      }
    } catch (err: any) {
      setSyncLogs(["[ERROR] Network fault: " + err.message]);
    } finally {
      setSyncLoading(false);
    }
  };

  const handleDeleteJob = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this job description?")) return;
    try {
      const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        await fetchJobs();
        await fetchAnalytics();
        if (selectedJob?.id === id) {
          setSelectedJob(null);
        }
      }
    } catch (err) {
      console.error("Error deleting job", err);
    }
  };

  const handleResetDatabase = async () => {
    if (!confirm("Are you sure you want to reset the database to seeded defaults? All custom additions will be cleared.")) return;
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        await fetchJobs();
        await fetchInteractions();
        await fetchAnalytics();
        setEvaluationResult(null);
        setAgentTrace([]);
        setAgentToolsUsed([]);
        setError(null);
        setSyncLogs([]);
        alert("Simulated Postgres database cleared and successfully re-seeded.");
      }
    } catch (err) {
      console.error("Error resetting database", err);
    }
  };

  const getStatusConfig = (status?: string) => {
    switch (status) {
      case "STRONG MATCH":
        return {
          bg: "bg-emerald-950/40 text-emerald-400 border-emerald-800/60",
          icon: <CheckCircle className="w-5 h-5 text-emerald-400" />
        };
      case "REVIEW REQUIRED":
        return {
          bg: "bg-amber-950/40 text-amber-400 border-amber-800/60",
          icon: <AlertTriangle className="w-5 h-5 text-amber-400" />
        };
      case "REJECTED":
        return {
          bg: "bg-rose-950/40 text-rose-400 border-rose-800/60",
          icon: <XCircle className="w-5 h-5 text-rose-400" />
        };
      default:
        return {
          bg: "bg-[#181818] text-[#888] border-[#2A2A2A]",
          icon: <Activity className="w-5 h-5 text-[#888]" />
        };
    }
  };

  // Filtered jobs list
  const filteredJobs = jobs.filter((job) => {
    const matchesSearch =
      job.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      job.company.toLowerCase().includes(searchQuery.toLowerCase()) ||
      job.description.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesSource = selectedSourceFilter === "ALL" || job.source === selectedSourceFilter;
    const matchesTrack =
      selectedTrackFilter === "ALL" ||
      (selectedTrackFilter === "TRACK_A" && job.assigned_track?.includes("Track A")) ||
      (selectedTrackFilter === "TRACK_B" && job.assigned_track?.includes("Track B")) ||
      (selectedTrackFilter === "UNASSIGNED" && !job.status);

    return matchesSearch && matchesSource && matchesTrack;
  });

  return (
    <div className="min-h-screen bg-[#0F0F0F] text-[#E0E0E0] font-sans selection:bg-[#D4AF37]/30 selection:text-white" id="main_container">
      {/* Upper Accent Header Line */}
      <div className="h-[2px] bg-[#D4AF37] w-full" />

      {/* Primary Header */}
      <header className="border-b border-[#2A2A2A] bg-[#141414] sticky top-0 z-50 px-6 py-4" id="app_header">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex flex-col">
            <h1 className="text-2xl font-light tracking-widest text-[#D4AF37] uppercase font-serif flex items-center gap-2">
              Job Decision Engine
              <span className="text-[10px] tracking-normal font-mono px-2 py-0.5 rounded bg-[#1C1C1C] text-[#888] border border-[#2A2A2A] uppercase">
                v3.0-open-source
              </span>
            </h1>
            <p className="text-[10px] text-[#888] tracking-[0.2em] uppercase mt-1">
              Multi-Stage Weighted auDHD Career Architect • Verified Portals
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-6 md:gap-8">
            {/* Navigation Tabs */}
            <div className="flex bg-[#181818] p-1 rounded-lg border border-[#2A2A2A]">
              <button
                onClick={() => setActiveTab("vault")}
                className={`px-4 py-1.5 rounded-md text-xs uppercase tracking-wider font-semibold transition-all cursor-pointer ${
                  activeTab === "vault"
                    ? "bg-[#D4AF37] text-[#0F0F0F]"
                    : "text-[#888] hover:text-[#E0E0E0]"
                }`}
              >
                Vault & Decisions
              </button>
              <button
                onClick={() => {
                  setActiveTab("analytics");
                  fetchAnalytics();
                }}
                className={`px-4 py-1.5 rounded-md text-xs uppercase tracking-wider font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                  activeTab === "analytics"
                    ? "bg-[#D4AF37] text-[#0F0F0F]"
                    : "text-[#888] hover:text-[#E0E0E0]"
                }`}
              >
                <Flame className="w-3.5 h-3.5" />
                ND Culture Analytics
              </button>
            </div>

            <div className="flex items-center gap-3 pl-4 border-l border-[#2A2A2A]">
              <button
                onClick={handleResetDatabase}
                className="px-3 py-1.5 rounded border border-[#2A2A2A] hover:bg-[#1C1C1C] text-xs text-[#888] hover:text-[#E0E0E0] flex items-center gap-1.5 transition-all cursor-pointer"
                title="Reset Simulated Database"
                id="reset_db_btn"
              >
                <RefreshCw className="w-3.5 h-3.5 text-[#D4AF37]" />
                Reset Database
              </button>
              <div className="text-xs font-mono text-[#888] bg-[#1C1C1C] px-3 py-1.5 rounded border border-[#2A2A2A] hidden sm:block">
                User: <span className="text-[#4CAF50]">Elena O.</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto p-6" id="dashboard_grid">
        <AnimatePresence mode="wait">
          {activeTab === "vault" ? (
            <motion.div
              key="vault_tab"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-6"
            >
              {/* Left Column (Job Vault & In-DB Operations) - Span 5 */}
              <section className="lg:col-span-5 flex flex-col gap-6" id="left_column">
                
                {/* User Profile Summary Cards */}
                <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-5 flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-[#1A1A1A] pb-2">
                    <h2 className="text-xs font-semibold uppercase tracking-widest text-[#D4AF37] flex items-center gap-2 font-serif">
                      <Shield className="w-3.5 h-3.5 text-[#D4AF37]" />
                      auDHD Criteria & Weights
                    </h2>
                    <span className="text-[10px] font-mono text-[#888] bg-[#1C1C1C] px-2 py-0.5 border border-[#2A2A2A] rounded">
                      criteria.ts
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="bg-[#181818] p-3 rounded border border-[#2A2A2A]">
                      <span className="text-[#888] block text-[10px] uppercase tracking-wider mb-1">Target Trajectory</span>
                      <span className="font-light text-[#E0E0E0] text-[11px] leading-relaxed">
                        Hands-on Architecture, Coding, Agentic RAG Systems
                      </span>
                    </div>
                    <div className="bg-[#181818] p-3 rounded border border-[#2A2A2A]">
                      <span className="text-[#888] block text-[10px] uppercase tracking-wider mb-1">Target Savings Target</span>
                      <span className="font-light text-[#D4AF37] text-sm">+$1,000,000 SGD</span>
                    </div>
                    <div className="bg-[#181818] p-3 rounded border border-[#2A2A2A] col-span-2">
                      <span className="text-[#888] block text-[10px] uppercase tracking-wider mb-1">Strict Guardrails (No-Politics)</span>
                      <span className="font-light text-[#E0E0E0] text-[11px] flex items-center gap-1.5 leading-relaxed">
                        <Zap className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />
                        Max 3 days office • Travel &lt; 10% • Direct culture. Avoid client-advisory / PM storytelling workloads.
                      </span>
                    </div>
                  </div>
                </div>

                {/* Automated Agent Integration Hub */}
                <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-5 flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-[#1A1A1A] pb-2">
                    <div className="flex items-center gap-2">
                      <Sliders className="w-4 h-4 text-[#D4AF37]" />
                      <h2 className="font-serif text-[#D4AF37] text-xs uppercase tracking-wider font-light">Automated Crawler Sync Agents</h2>
                    </div>
                    <button
                      onClick={() => setShowAgentHub(!showAgentHub)}
                      className="text-[10px] text-[#D4AF37] hover:underline font-mono"
                    >
                      {showAgentHub ? "Hide Agent Console" : "Configure Agents"}
                    </button>
                  </div>

                  <p className="text-xs text-[#888] leading-relaxed">
                    Integrate your sources automatically. Trigger scraper agents to scan LinkedIn, MCF, and eFinancialCareers or monitor Gmail alerts for hands-on job listings matching your criteria.
                  </p>

                  {/* Config and Logs */}
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <label className="flex items-center gap-2 bg-[#181818] border border-[#2A2A2A] p-2.5 rounded cursor-pointer hover:bg-[#1C1C1C] transition">
                        <input
                          type="checkbox"
                          checked={agentConfig.linkedin}
                          onChange={(e) => setAgentConfig({ ...agentConfig, linkedin: e.target.checked })}
                          className="accent-[#D4AF37] w-3.5 h-3.5"
                        />
                        <span className="text-[#AAA]">LinkedIn Agent</span>
                      </label>
                      <label className="flex items-center gap-2 bg-[#181818] border border-[#2A2A2A] p-2.5 rounded cursor-pointer hover:bg-[#1C1C1C] transition">
                        <input
                          type="checkbox"
                          checked={agentConfig.mycareersfuture}
                          onChange={(e) => setAgentConfig({ ...agentConfig, mycareersfuture: e.target.checked })}
                          className="accent-[#D4AF37] w-3.5 h-3.5"
                        />
                        <span className="text-[#AAA]">MyCareersFuture</span>
                      </label>
                      <label className="flex items-center gap-2 bg-[#181818] border border-[#2A2A2A] p-2.5 rounded cursor-pointer hover:bg-[#1C1C1C] transition">
                        <input
                          type="checkbox"
                          checked={agentConfig.efinancialcareers}
                          onChange={(e) => setAgentConfig({ ...agentConfig, efinancialcareers: e.target.checked })}
                          className="accent-[#D4AF37] w-3.5 h-3.5"
                        />
                        <span className="text-[#AAA]">eFinancialCareers</span>
                      </label>
                      <label className="flex items-center gap-2 bg-[#181818] border border-[#2A2A2A] p-2.5 rounded cursor-pointer hover:bg-[#1C1C1C] transition">
                        <input
                          type="checkbox"
                          checked={agentConfig.gmail}
                          onChange={(e) => setAgentConfig({ ...agentConfig, gmail: e.target.checked })}
                          className="accent-[#D4AF37] w-3.5 h-3.5"
                        />
                        <span className="text-[#AAA] flex items-center gap-1.5">
                          <Mail className="w-3 h-3 text-[#4CAF50]" />
                          Gmail Notifications
                        </span>
                      </label>
                    </div>

                    <button
                      onClick={handleSyncAgents}
                      disabled={syncLoading}
                      className="w-full py-2.5 bg-[#1C1C1C] hover:bg-[#D4AF37] hover:text-[#0F0F0F] text-[#D4AF37] border border-[#D4AF37]/30 hover:border-transparent font-semibold text-xs uppercase tracking-widest transition-all cursor-pointer rounded flex items-center justify-center gap-2 disabled:opacity-40"
                    >
                      {syncLoading ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          Crawlers Searching Boards...
                        </>
                      ) : (
                        <>
                          <Cpu className="w-3.5 h-3.5" />
                          Execute Automatic Source Crawl
                        </>
                      )}
                    </button>

                    {/* Scrollable Agent Sync terminal logs */}
                    {syncLogs.length > 0 && (
                      <div className="bg-black/80 border border-[#2A2A2A] p-3 rounded font-mono text-[10px] text-[#A9FFB2] max-h-[140px] overflow-y-auto flex flex-col gap-1 leading-normal">
                        <div className="text-[#888] border-b border-[#2A2A2A] pb-1 mb-1 uppercase tracking-widest text-[9px] flex justify-between">
                          <span>Agent Execution Output Trace</span>
                          <span className="text-[#4CAF50]">Success</span>
                        </div>
                        {syncLogs.map((log, idx) => (
                          <div key={idx} className="whitespace-pre-wrap">
                            <span className="text-[#555] mr-1">&gt;</span>
                            {log}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Database Job Vault */}
                <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-5 flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-[#1A1A1A] pb-2">
                    <div className="flex items-center gap-2">
                      <Database className="w-4 h-4 text-[#D4AF37]" />
                      <h2 className="font-serif text-[#D4AF37] text-sm tracking-wider uppercase font-light">Postgres Job Vault</h2>
                    </div>
                    <button
                      onClick={() => setShowAddForm(!showAddForm)}
                      className="px-3 py-1 bg-[#D4AF37] text-[#0F0F0F] font-semibold text-[10px] uppercase tracking-wider hover:brightness-110 transition-all cursor-pointer rounded"
                      id="add_job_btn"
                    >
                      <Plus className="w-3 h-3 inline mr-1 stroke-[3]" />
                      Add JD
                    </button>
                  </div>

                  {/* Add Custom Job Form */}
                  <AnimatePresence>
                    {showAddForm && (
                      <motion.form
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        onSubmit={handleAddCustomJob}
                        className="bg-[#141414] border border-[#2A2A2A] rounded-lg p-4 flex flex-col gap-3 overflow-hidden text-xs"
                        id="add_job_form"
                      >
                        <h3 className="font-serif text-[#D4AF37] font-semibold uppercase tracking-wider text-[10px]">Import Raw Job Description</h3>
                        
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[#888] block mb-1 uppercase text-[9px] tracking-wider">Job Title</label>
                            <input
                              type="text"
                              required
                              value={customTitle}
                              onChange={(e) => setCustomTitle(e.target.value)}
                              placeholder="e.g. AI Architect"
                              className="w-full bg-[#181818] border border-[#2A2A2A] rounded px-2.5 py-1.5 text-[#E0E0E0] focus:outline-none focus:border-[#D4AF37]"
                            />
                          </div>
                          <div>
                            <label className="text-[#888] block mb-1 uppercase text-[9px] tracking-wider">Company</label>
                            <input
                              type="text"
                              required
                              value={customCompany}
                              onChange={(e) => setCustomCompany(e.target.value)}
                              placeholder="e.g. Novartis"
                              className="w-full bg-[#181818] border border-[#2A2A2A] rounded px-2.5 py-1.5 text-[#E0E0E0] focus:outline-none focus:border-[#D4AF37]"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[#888] block mb-1 uppercase text-[9px] tracking-wider">Source Portal</label>
                            <select
                              value={customSource}
                              onChange={(e) => setCustomSource(e.target.value as Job["source"])}
                              className="w-full bg-[#181818] border border-[#2A2A2A] rounded px-2.5 py-1.5 text-[#E0E0E0] focus:outline-none focus:border-[#D4AF37]"
                            >
                              <option value="LinkedIn">LinkedIn</option>
                              <option value="MyCareersFuture">MyCareersFuture</option>
                              <option value="eFinancialCareers">eFinancialCareers</option>
                              <option value="Gmail">Gmail Alert Notification</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-[#888] block mb-1 uppercase text-[9px] tracking-wider">Careers Portal Verification URL</label>
                            <input
                              type="url"
                              value={customCareersUrl}
                              onChange={(e) => setCustomCareersUrl(e.target.value)}
                              placeholder="e.g. https://gsk.com/careers"
                              className="w-full bg-[#181818] border border-[#2A2A2A] rounded px-2.5 py-1.5 text-[#E0E0E0] focus:outline-none focus:border-[#D4AF37] font-mono text-[10px]"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[#888] block mb-1 uppercase text-[9px] tracking-wider">Salary Range</label>
                            <input
                              type="text"
                              value={customSalary}
                              onChange={(e) => setCustomSalary(e.target.value)}
                              placeholder="e.g. SGD 24,000"
                              className="w-full bg-[#181818] border border-[#2A2A2A] rounded px-2.5 py-1.5 text-[#E0E0E0] focus:outline-none focus:border-[#D4AF37]"
                            />
                          </div>
                          <div>
                            <label className="text-[#888] block mb-1 uppercase text-[9px] tracking-wider">Location</label>
                            <input
                              type="text"
                              value={customLocation}
                              onChange={(e) => setCustomLocation(e.target.value)}
                              placeholder="e.g. Singapore (Remote)"
                              className="w-full bg-[#181818] border border-[#2A2A2A] rounded px-2.5 py-1.5 text-[#E0E0E0] focus:outline-none focus:border-[#D4AF37]"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="text-[#888] block mb-1 uppercase text-[9px] tracking-wider">Job Description (Raw LinkedIn/Board Text)</label>
                          <textarea
                            required
                            value={customDescription}
                            onChange={(e) => setCustomDescription(e.target.value)}
                            placeholder="Paste raw JD from LinkedIn or email notification alert here..."
                            rows={4}
                            className="w-full bg-[#181818] border border-[#2A2A2A] rounded px-2.5 py-1.5 text-[#E0E0E0] focus:outline-none focus:border-[#D4AF37] font-mono text-[11px]"
                          />
                        </div>

                        <div className="flex justify-end gap-2 mt-1">
                          <button
                            type="button"
                            onClick={() => setShowAddForm(false)}
                            className="px-3 py-1.5 rounded bg-[#1C1C1C] border border-[#2A2A2A] text-[#888] hover:text-[#E0E0E0]"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="px-3 py-1.5 rounded bg-[#D4AF37] text-[#0F0F0F] font-semibold hover:brightness-110 transition"
                          >
                            Save to Vault
                          </button>
                        </div>
                      </motion.form>
                    )}
                  </AnimatePresence>

                  {/* Search and Filters */}
                  <div className="flex flex-col gap-2 bg-[#161616] p-3 rounded-lg border border-[#2A2A2A]">
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Search className="w-3.5 h-3.5 text-[#555] absolute left-2.5 top-2.5" />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search title, company or keyword..."
                          className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded pl-8 pr-2.5 py-1.5 text-[11px] placeholder-[#555] focus:outline-none focus:border-[#D4AF37]"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                      <div>
                        <span className="text-[#666] uppercase block text-[8px] tracking-widest mb-1 font-mono">Board</span>
                        <select
                          value={selectedSourceFilter}
                          onChange={(e) => setSelectedSourceFilter(e.target.value)}
                          className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded p-1 text-[#AAA]"
                        >
                          <option value="ALL">All Boards</option>
                          <option value="LinkedIn">LinkedIn</option>
                          <option value="MyCareersFuture">MyCareersFuture</option>
                          <option value="eFinancialCareers">eFinancialCareers</option>
                          <option value="Gmail">Gmail</option>
                        </select>
                      </div>
                      <div>
                        <span className="text-[#666] uppercase block text-[8px] tracking-widest mb-1 font-mono">Engine Status</span>
                        <select
                          value={selectedTrackFilter}
                          onChange={(e) => setSelectedTrackFilter(e.target.value)}
                          className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded p-1 text-[#AAA]"
                        >
                          <option value="ALL">All Vault Status</option>
                          <option value="TRACK_A">Track A (Finance/AI)</option>
                          <option value="TRACK_B">Track B (Pharma/Bio)</option>
                          <option value="UNASSIGNED">Unassigned (Need Eval)</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Jobs List container */}
                  <div className="flex flex-col max-h-[350px] overflow-y-auto pr-1 border border-[#1A1A1A] rounded-lg" id="jobs_vault_list">
                    {filteredJobs.length > 0 ? (
                      filteredJobs.map((job) => {
                        const isEvaluated = !!job.status;
                        const scoreColor = job.total_score && job.total_score >= 80 
                          ? "text-emerald-400" 
                          : job.total_score && job.total_score >= 50 
                            ? "text-amber-400" 
                            : "text-rose-400";
                        return (
                          <div
                            key={job.id}
                            onClick={() => setSelectedJob(job)}
                            className={`p-4 cursor-pointer text-xs transition-all relative border-b border-[#1A1A1A] ${
                              selectedJob?.id === job.id
                                ? "bg-[#1C1C1C] border-l-2 border-[#D4AF37]"
                                : "bg-transparent hover:bg-[#121212]/40"
                            }`}
                            id={`job_card_${job.id}`}
                          >
                            <div className="flex items-start justify-between gap-3 mb-1.5">
                              <div>
                                <h3 className="font-serif text-[#E0E0E0] text-sm tracking-wide font-light flex items-center gap-1.5">
                                  {job.title}
                                </h3>
                                <p className="text-[#888] text-[11px] mt-0.5">{job.company}</p>
                              </div>
                              <div className="flex flex-col items-end gap-1 shrink-0">
                                <span className="text-[9px] uppercase font-mono px-2 py-0.5 rounded bg-[#141414] text-[#888] border border-[#2A2A2A]">
                                  {job.source}
                                </span>
                                {isEvaluated && (
                                  <span className={`text-[10px] font-mono font-bold ${scoreColor}`}>
                                    Score: {job.total_score}
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                              {job.salaryRange && (
                                <div className="flex items-center gap-1.5 text-[#888] font-mono text-[10px]">
                                  <TrendingUp className="w-3.5 h-3.5 text-[#4CAF50] opacity-80" />
                                  <span>{job.salaryRange}</span>
                                </div>
                              )}
                              {job.location && (
                                <div className="flex items-center gap-1.5 text-[#888] font-mono text-[10px]">
                                  <MapPin className="w-3.5 h-3.5 text-[#D4AF37] opacity-80" />
                                  <span>{job.location}</span>
                                </div>
                              )}
                            </div>

                            <div className="mt-3 flex justify-between items-center text-[10px] uppercase tracking-wider font-mono">
                              <span className="text-[#555]">Posted: {job.postedDate || "Just now"}</span>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={(e) => handleDeleteJob(job.id, e)}
                                  className="text-[#666] hover:text-red-400 font-medium transition cursor-pointer"
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="text-center py-10 text-[#555] text-xs uppercase tracking-wider font-mono">
                        No matches in the Postgres database vault.
                      </div>
                    )}
                  </div>
                </div>

                {/* Prompt Sandbox */}
                <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-5 flex flex-col gap-3">
                  <h2 className="font-serif text-[#D4AF37] text-xs uppercase tracking-wider font-light flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-[#D4AF37]" />
                    General Sandbox Evaluator
                  </h2>
                  <p className="text-xs text-[#888] leading-relaxed">
                    Input custom queries or specific criteria variations. The Agent will decide which tools are required to retrieve current facts.
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={activeQuestion}
                      onChange={(e) => setActiveQuestion(e.target.value)}
                      placeholder="e.g., Run eFinancialCareers benchmark rates for Quantum..."
                      className="flex-1 bg-[#181818] border border-[#2A2A2A] rounded px-3 py-2 text-xs text-[#E0E0E0] placeholder-[#555] focus:outline-none focus:border-[#D4AF37]"
                    />
                    <button
                      disabled={loading || !activeQuestion}
                      onClick={() => handleAskAgent(activeQuestion)}
                      className="px-4 py-2 rounded bg-[#D4AF37] text-[#0F0F0F] font-semibold text-xs uppercase tracking-wider disabled:opacity-40 hover:brightness-110 transition cursor-pointer"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </section>

              {/* Right Column (Decision Console & Trace Audit) - Span 7 */}
              <section className="lg:col-span-7 flex flex-col gap-6" id="right_column">
                
                {/* Main Selected Job Detail & Trigger */}
                <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-5 flex flex-col gap-4">
                  {selectedJob ? (
                    <div>
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#1A1A1A] pb-4 mb-4">
                        <div>
                          <span className="text-[9px] uppercase tracking-widest text-[#888] block">Selected Vault Entry</span>
                          <h2 className="text-xl font-serif text-white italic font-light mt-1">{selectedJob.title}</h2>
                          <p className="text-xs text-[#888] font-light mt-0.5">{selectedJob.company} • {selectedJob.location || "Singapore"}</p>
                          
                          {/* Careers Portal Link to verify it's a real job */}
                          <div className="flex items-center gap-2 mt-2 text-xs">
                            <Globe className="w-3.5 h-3.5 text-[#D4AF37]" />
                            <span className="text-[#888]">Verify Real Job:</span>
                            <a
                              href={selectedJob.careers_portal_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[#D4AF37] hover:underline font-mono text-[11px] truncate max-w-[280px]"
                            >
                              {selectedJob.careers_portal_url}
                            </a>
                          </div>
                        </div>
                        <button
                          onClick={handleEvaluateSelectedJob}
                          disabled={loading}
                          className="px-4 py-2.5 rounded bg-[#D4AF37] text-[#0F0F0F] font-semibold text-xs uppercase tracking-widest hover:brightness-110 disabled:opacity-50 transition-all cursor-pointer flex items-center gap-1.5 shrink-0"
                          id="evaluate_btn"
                        >
                          <Cpu className="w-4 h-4 animate-pulse" />
                          Evaluate Engine
                        </button>
                      </div>

                      <div className="max-h-[160px] overflow-y-auto bg-[#181818] border border-[#2A2A2A] p-4 rounded text-xs">
                        <h3 className="text-xs font-serif text-[#D4AF37] font-semibold uppercase tracking-wider mb-2">Description Brief</h3>
                        <p className="text-[#CCC] leading-relaxed font-mono whitespace-pre-line text-[11px]">{selectedJob.description}</p>
                      </div>

                      {/* Display Cached Database evaluation metrics if they exist */}
                      {selectedJob.status && (
                        <div className="mt-4 pt-4 border-t border-[#1A1A1A] grid grid-cols-1 md:grid-cols-3 gap-3 text-xs bg-[#161616]/40 p-3 rounded border border-[#2A2A2A]">
                          <div>
                            <span className="text-[#666] block text-[9px] uppercase tracking-wider">Evaluation Grade</span>
                            <span className="font-serif font-semibold text-[#D4AF37] text-sm">{selectedJob.status}</span>
                          </div>
                          <div>
                            <span className="text-[#666] block text-[9px] uppercase tracking-wider">Match Score</span>
                            <span className="font-serif font-bold text-white text-sm">{selectedJob.total_score} / 100</span>
                          </div>
                          <div>
                            <span className="text-[#666] block text-[9px] uppercase tracking-wider">ND Friendly Score</span>
                            <span className="font-serif font-bold text-emerald-400 text-sm">{selectedJob.nd_friendly_score}%</span>
                          </div>
                          <div className="col-span-1 md:col-span-3 border-t border-[#2A2A2A] pt-2 mt-1">
                            <span className="text-[#666] block text-[9px] uppercase tracking-wider">Recommended Strategy</span>
                            <p className="text-[#AAA] text-[11px] font-mono mt-0.5 leading-relaxed">{selectedJob.next_action} • Use {selectedJob.recommended_cv_version}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center py-10 text-[#555] text-xs uppercase tracking-wider">
                      Select a job from the vault or add a custom description to begin evaluation.
                    </div>
                  )}
                </div>

                {/* Loader State */}
                {loading && (
                  <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-8 flex flex-col items-center justify-center gap-4 text-center">
                    <RefreshCw className="w-8 h-8 text-[#D4AF37] animate-spin" />
                    <div>
                      <h3 className="text-sm font-serif text-white uppercase tracking-wider font-light">Multi-Stage Evaluation Active</h3>
                      <p className="text-xs text-[#888] mt-2 max-w-sm leading-relaxed">
                        Gemini is executing the 3-Stage Decision Engine pipeline. Triggering disqualifier lookups and REST benchmarking metrics...
                      </p>
                    </div>
                  </div>
                )}

                {/* Error Banner */}
                {error && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5 text-xs flex items-start gap-3 text-red-400">
                    <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h4 className="font-semibold text-white uppercase tracking-wider mb-1">Decision Engine Pipeline Failed</h4>
                      <p className="leading-relaxed font-mono text-[11px]">{error}</p>
                    </div>
                  </div>
                )}

                {/* Interactive Structured Output */}
                <AnimatePresence>
                  {evaluationResult && !loading && (
                    <motion.div
                      initial={{ opacity: 0, y: 15 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex flex-col gap-6"
                      id="evaluation_results_section"
                    >
                      {evaluationResult.evaluated_jobs.map((job, idx) => {
                        const statusUi = getStatusConfig(job.status);
                        return (
                          <div key={idx} className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-6 flex flex-col gap-6">
                            
                            {/* Gate 1 & 2 Headers */}
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#2A2A2A] pb-4">
                              <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-3">
                                  <div className={`border px-3 py-1 rounded text-[10px] uppercase font-semibold tracking-wider flex items-center gap-1.5 ${statusUi.bg}`}>
                                    {statusUi.icon}
                                    {job.status}
                                  </div>
                                  <span className="px-2.5 py-1 bg-[#D4AF3722] border border-[#D4AF3744] text-[#D4AF37] text-[10px] uppercase tracking-widest rounded-full font-mono">
                                    {job.confidence_level} CONFIDENCE MATCH
                                  </span>
                                </div>
                                <div className="mt-1">
                                  <span className="text-[10px] uppercase font-semibold text-[#888] tracking-wider block font-mono">Assigned Pipeline Track</span>
                                  <span className="font-semibold text-white text-xs">{job.assigned_track}</span>
                                </div>
                                {/* Verification link inside evaluation */}
                                <div className="flex items-center gap-1.5 mt-2">
                                  <Globe className="w-3.5 h-3.5 text-[#D4AF37]" />
                                  <a
                                    href={job.careers_portal_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[10px] uppercase tracking-wider text-[#D4AF37] hover:underline font-bold"
                                  >
                                    Verify Job on Company Portal
                                  </a>
                                </div>
                              </div>

                              <div className="text-center bg-[#181818] p-4 border border-[#2A2A2A] rounded min-w-[110px]">
                                <p className="text-[10px] text-[#888] uppercase tracking-widest font-mono">Final Score</p>
                                <p className="text-4xl font-serif text-[#D4AF37] mt-1">{job.total_score}</p>
                              </div>
                            </div>

                            {/* Hard Disqualifiers Notification (If Any) */}
                            {job.hard_disqualifiers_triggered && job.hard_disqualifiers_triggered.length > 0 && (
                              <div className="bg-red-500/10 border border-red-500/20 p-4 rounded text-xs text-red-400 flex items-start gap-2.5">
                                <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                                <div>
                                  <span className="font-serif text-red-200 block uppercase tracking-wider text-[10px]">Stage 1 Disqualifiers Triggered:</span>
                                  <ul className="list-disc pl-4 mt-1.5 space-y-1 font-mono text-[11px]">
                                    {job.hard_disqualifiers_triggered.map((dis, dIdx) => (
                                      <li key={dIdx}>{dis}</li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            )}

                            {/* auDHD Culture Ratings */}
                            <div>
                              <h3 className="text-xs font-serif text-[#D4AF37] uppercase tracking-widest mb-3 flex items-center gap-1.5">
                                <Activity className="w-3.5 h-3.5 text-[#D4AF37]" />
                                Stage 2: Neurotype Compatible Metrics
                              </h3>
                              <div className="grid grid-cols-3 gap-3 mb-4">
                                <div className="p-3 bg-[#161616] border border-[#2A2A2A] rounded text-center">
                                  <span className="text-[9px] text-[#666] uppercase block font-mono">ND-Safety Index</span>
                                  <span className="text-xl font-serif font-bold text-[#4CAF50]">{job.nd_friendly_score}%</span>
                                </div>
                                <div className="p-3 bg-[#161616] border border-[#2A2A2A] rounded text-center">
                                  <span className="text-[9px] text-[#666] uppercase block font-mono">Stress / Politics</span>
                                  <span className="text-xl font-serif font-bold text-red-400">{job.politics_stress_score}%</span>
                                </div>
                                <div className="p-3 bg-[#161616] border border-[#2A2A2A] rounded text-center">
                                  <span className="text-[9px] text-[#666] uppercase block font-mono">Sensory Overload</span>
                                  <span className="text-xl font-serif font-bold text-amber-400">{job.sensory_overload_index}%</span>
                                </div>
                              </div>
                            </div>

                            {/* Score Breakdown Bento Matrix */}
                            <div>
                              <h3 className="text-xs font-serif text-[#D4AF37] uppercase tracking-widest mb-3 flex items-center gap-1.5">
                                <Award className="w-3.5 h-3.5" />
                                Stage 3: Weighted Multi-Point Scoring Matrix
                              </h3>
                              
                              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
                                <div className="p-3 bg-[#141414] border border-[#2A2A2A] rounded">
                                  <p className="text-[9px] text-[#666] uppercase mb-1 font-mono">Tech Autonomy</p>
                                  <p className="text-lg font-serif text-[#E0E0E0]">{job.score_breakdown.technical_autonomy.score}<span className="text-xs text-[#444]">/30</span></p>
                                </div>
                                <div className="p-3 bg-[#141414] border border-[#2A2A2A] rounded">
                                  <p className="text-[9px] text-[#666] uppercase mb-1 font-mono">Capital Acc.</p>
                                  <p className="text-lg font-serif text-[#E0E0E0]">{job.score_breakdown.compensation_potential.score}<span className="text-xs text-[#444]">/25</span></p>
                                </div>
                                <div className="p-3 bg-[#141414] border border-[#2A2A2A] rounded">
                                  <p className="text-[9px] text-[#666] uppercase mb-1 font-mono">Domain Rel.</p>
                                  <p className="text-lg font-serif text-[#E0E0E0]">{job.score_breakdown.domain_relevance.score}<span className="text-xs text-[#444]">/20</span></p>
                                </div>
                                <div className="p-3 bg-[#141414] border border-[#2A2A2A] rounded">
                                  <p className="text-[9px] text-[#666] uppercase mb-1 font-mono">Guardrails</p>
                                  <p className="text-lg font-serif text-[#E0E0E0]">{job.score_breakdown.environment_guardrails.score}<span className="text-xs text-[#444]">/15</span></p>
                                </div>
                                <div className="p-3 bg-[#141414] border border-[#2A2A2A] rounded col-span-2 sm:col-span-1">
                                  <p className="text-[9px] text-[#666] uppercase mb-1 font-mono">Mobility</p>
                                  <p className="text-lg font-serif text-[#E0E0E0]">{job.score_breakdown.future_mobility.score}<span className="text-xs text-[#444]">/10</span></p>
                                </div>
                              </div>

                              {/* Detailed Score Rationales */}
                              <div className="space-y-2.5 mt-4">
                                <h4 className="text-[9px] uppercase tracking-wider text-[#888] font-mono">Scoring Matrix Rationale Breakdown</h4>
                                <div className="flex flex-col gap-2.5">
                                  <div className="bg-[#141414] p-3 rounded border border-[#2A2A2A] flex flex-col gap-1 text-xs">
                                    <div className="flex items-center justify-between font-mono text-[11px]">
                                      <span className="font-medium text-[#E0E0E0]">1. Technical & Creative Autonomy (30%)</span>
                                      <span className="font-mono text-[#D4AF37]">{job.score_breakdown.technical_autonomy.score} pts</span>
                                    </div>
                                    <p className="text-[11px] text-[#888] italic leading-relaxed">{job.score_breakdown.technical_autonomy.rationale}</p>
                                  </div>

                                  <div className="bg-[#141414] p-3 rounded border border-[#2A2A2A] flex flex-col gap-1 text-xs">
                                    <div className="flex items-center justify-between font-mono text-[11px]">
                                      <span className="font-medium text-[#E0E0E0]">2. Compensation & Capital Potential (25%)</span>
                                      <span className="font-mono text-[#D4AF37]">{job.score_breakdown.compensation_potential.score} pts</span>
                                    </div>
                                    <p className="text-[11px] text-[#888] italic leading-relaxed">{job.score_breakdown.compensation_potential.rationale}</p>
                                  </div>

                                  <div className="bg-[#141414] p-3 rounded border border-[#2A2A2A] flex flex-col gap-1 text-xs">
                                    <div className="flex items-center justify-between font-mono text-[11px]">
                                      <span className="font-medium text-[#E0E0E0]">3. Domain Relevance & Alignment (20%)</span>
                                      <span className="font-mono text-[#D4AF37]">{job.score_breakdown.domain_relevance.score} pts</span>
                                    </div>
                                    <p className="text-[11px] text-[#888] italic leading-relaxed">{job.score_breakdown.domain_relevance.rationale}</p>
                                  </div>

                                  <div className="bg-[#141414] p-3 rounded border border-[#2A2A2A] flex flex-col gap-1 text-xs">
                                    <div className="flex items-center justify-between font-mono text-[11px]">
                                      <span className="font-medium text-[#E0E0E0]">4. Environmental & Biological Guardrails (15%)</span>
                                      <span className="font-mono text-[#D4AF37]">{job.score_breakdown.environment_guardrails.score} pts</span>
                                    </div>
                                    <p className="text-[11px] text-[#888] italic leading-relaxed">{job.score_breakdown.environment_guardrails.rationale}</p>
                                  </div>

                                  <div className="bg-[#141414] p-3 rounded border border-[#2A2A2A] flex flex-col gap-1 text-xs">
                                    <div className="flex items-center justify-between font-mono text-[11px]">
                                      <span className="font-medium text-[#E0E0E0]">5. Future-Proofing & Netherlands Mobility (10%)</span>
                                      <span className="font-mono text-[#D4AF37]">{job.score_breakdown.future_mobility.score} pts</span>
                                    </div>
                                    <p className="text-[11px] text-[#888] italic leading-relaxed">{job.score_breakdown.future_mobility.rationale}</p>
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Biological Risk Assessment & Strategy boxes */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-2">
                              <div className="space-y-2 text-xs">
                                <h3 className="text-xs font-serif text-[#D4AF37] uppercase tracking-widest">Strategic Value Analysis</h3>
                                <p className="text-xs text-[#AAA] leading-relaxed font-mono text-[11px]">{job.strategic_value}</p>
                              </div>

                              <div className="space-y-2 text-xs">
                                <h3 className="text-xs font-serif text-[#D4AF37] uppercase tracking-widest">auDHD Biological Guardrails Analysis</h3>
                                <div className="p-4 bg-[#141414] border-l-2 border-[#4CAF50] rounded">
                                  <p className="text-xs italic text-[#CCC] leading-relaxed font-mono text-[11px]">"{job.biological_and_stress_risk_assessment}"</p>
                                </div>
                              </div>
                            </div>

                            {/* Next Step actions */}
                            <div className="bg-[#141414] border border-[#2A2A2A] p-4 rounded flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs mt-2">
                              <div className="flex items-center gap-3">
                                <div className="bg-[#181818] p-2 rounded border border-[#2A2A2A]">
                                  <Briefcase className="w-4 h-4 text-[#D4AF37]" />
                                </div>
                                <div>
                                  <span className="text-[9px] text-[#555] block uppercase font-mono tracking-wider">Suggested Resume Match</span>
                                  <span className="font-light text-white text-[11px]">{job.recommended_cv_version}</span>
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                <span className="text-[9px] text-[#555] uppercase font-mono tracking-wider hidden sm:inline">Next Step:</span>
                                <div className="bg-[#D4AF3722] text-[#D4AF37] px-3.5 py-1.5 rounded text-[11px] font-semibold border border-[#D4AF3744] flex items-center gap-1.5">
                                  {job.next_action}
                                  <ArrowRight className="w-3.5 h-3.5" />
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {/* Agent Call Trace Audit Trail */}
                      {agentTrace.length > 0 && (
                        <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-5 flex flex-col gap-3">
                          <h3 className="text-xs font-serif uppercase tracking-widest text-[#D4AF37] flex items-center gap-1.5">
                            <Terminal className="w-3.5 h-3.5 text-[#D4AF37]" />
                            Live Agent Tool-Call Trace & Decisions
                          </h3>
                          <div className="bg-[#181818] p-4 rounded border border-[#2A2A2A] font-mono text-[11px] text-[#AAA] max-h-[180px] overflow-y-auto flex flex-col gap-1">
                            {agentTrace.map((tr, trIdx) => (
                              <div key={trIdx} className="flex gap-2">
                                <span className="text-[#555] select-none">{trIdx + 1}.</span>
                                <span className={tr.includes("triggered tool call") ? "text-[#D4AF37]" : ""}>{tr}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Database Log Trail / Activity Panel */}
                <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-5 flex flex-col gap-4">
                  <h3 className="text-xs font-serif uppercase tracking-widest text-[#D4AF37] flex items-center gap-1.5">
                    <Database className="w-4 h-4 text-[#D4AF37]" />
                    Persistent Interaction History (Logged to Postgres)
                  </h3>
                  <div className="flex flex-col gap-2 max-h-[160px] overflow-y-auto pr-1" id="interactions_log_list">
                    {interactions.length > 0 ? (
                      interactions.map((it) => (
                        <div key={it.id} className="bg-[#181818] p-3.5 rounded border border-[#2A2A2A] flex items-center justify-between gap-3 text-[11px]">
                          <div className="flex-1 min-w-0">
                            <p className="text-[#E0E0E0] font-mono font-medium truncate">"{it.question}"</p>
                            <div className="flex items-center gap-3 text-[#666] mt-1.5 font-mono text-[10px] uppercase tracking-wider">
                              <span>{new Date(it.timestamp).toLocaleString()}</span>
                              {it.toolsUsed.length > 0 && (
                                <span className="text-[#D4AF37]">Tools: [{it.toolsUsed.join(", ")}]</span>
                              )}
                            </div>
                          </div>
                          <ChevronRight className="w-4 h-4 text-[#555]" />
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-6 text-[#555] text-[11px] uppercase tracking-wider">
                        No interactions logged yet. Run an evaluation to seed the Postgres audit history.
                      </div>
                    )}
                  </div>
                </div>

              </section>
            </motion.div>
          ) : (
            /* Neurodivergent & auDHD Corporate Culture Analytics Panel */
            <motion.div
              key="analytics_tab"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="flex flex-col gap-6"
            >
              {/* Introduction Banner */}
              <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div>
                  <h2 className="text-2xl font-serif text-[#D4AF37] font-light uppercase tracking-wider">
                    Neurodivergent Corporate Nervous Systems Analytics
                  </h2>
                  <p className="text-xs text-[#888] mt-1.5 max-w-2xl leading-relaxed">
                    Forkable Open-Source Analytics Dashboard. Compiling ratings aggregated directly from simulated Postgres job evaluations to help auDHD builders discover supportive companies, verify live jobs, and flag highly political, toxic, or high-burnout workplaces.
                  </p>
                </div>
                <div className="bg-[#181818] border border-[#2A2A2A] px-5 py-4 rounded text-center shrink-0 min-w-[130px]">
                  <span className="text-[9px] uppercase tracking-widest text-[#666] font-mono block">Data Vault Set</span>
                  <span className="text-3xl font-serif text-[#D4AF37] font-bold block mt-1">
                    {analytics.ndApproved.length + analytics.toxicBlacklist.length}
                  </span>
                  <span className="text-[9px] uppercase text-[#4CAF50] font-mono mt-1 block">evaluated</span>
                </div>
              </div>

              {/* Grid: Approved Supportive vs High Burnout Blacklist */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                
                {/* Panel 1: Highly Approved ND-Friendly Companies */}
                <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-5 flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-[#2A2A2A] pb-3">
                    <h3 className="font-serif text-[#4CAF50] text-sm uppercase tracking-widest flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-[#4CAF50]" />
                      Highly Approved Corporate Environments
                    </h3>
                    <span className="text-[9px] font-mono bg-[#4CAF50]/10 border border-[#4CAF50]/30 text-[#4CAF50] px-2 py-0.5 rounded uppercase">
                      ND-Score &gt;= 70
                    </span>
                  </div>

                  <div className="flex flex-col gap-4">
                    {analytics.ndApproved.length > 0 ? (
                      analytics.ndApproved.map((co, cIdx) => (
                        <div key={cIdx} className="bg-[#161616] border border-[#2A2A2A] p-4 rounded-lg flex flex-col gap-3 hover:border-[#4CAF50]/30 transition">
                          <div className="flex justify-between items-start">
                            <div>
                              <h4 className="font-serif text-white font-medium text-sm tracking-wide">{co.company}</h4>
                              <p className="text-[#888] text-[10px] uppercase tracking-wider mt-0.5">{co.industry}</p>
                            </div>
                            <div className="text-right">
                              <span className="text-[10px] text-[#888] uppercase block font-mono">ND Safety Score</span>
                              <span className="text-xl font-serif font-bold text-[#4CAF50]">{co.nd_friendly_score}%</span>
                            </div>
                          </div>

                          {/* Dynamic Meters */}
                          <div className="space-y-2 mt-1">
                            <div>
                              <div className="flex justify-between text-[9px] uppercase tracking-wider text-[#666] mb-1 font-mono">
                                <span>Focus Protection / Async Level</span>
                                <span className="text-[#AAA]">{100 - co.sensory_overload_index}%</span>
                              </div>
                              <div className="h-1 bg-black rounded-full overflow-hidden">
                                <div className="h-full bg-[#4CAF50]" style={{ width: `${100 - co.sensory_overload_index}%` }} />
                              </div>
                            </div>
                            <div>
                              <div className="flex justify-between text-[9px] uppercase tracking-wider text-[#666] mb-1 font-mono">
                                <span>Low Politics Index</span>
                                <span className="text-[#AAA]">{100 - co.politics_stress_score}%</span>
                              </div>
                              <div className="h-1 bg-black rounded-full overflow-hidden">
                                <div className="h-full bg-[#D4AF37]" style={{ width: `${100 - co.politics_stress_score}%` }} />
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center justify-between border-t border-[#2A2A2A] pt-3 text-[11px] font-mono mt-1">
                            <span className="text-[#666]">Evaluations: {co.jobs_count} JDs</span>
                            <a
                              href={co.careers_portal_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[#D4AF37] hover:underline flex items-center gap-1"
                            >
                              Verify careers portal <ChevronRight className="w-3 h-3" />
                            </a>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-12 text-[#555] text-xs uppercase tracking-wider font-mono">
                        No approved safe-spaces evaluated yet. Complete strong evaluations in the Decisions tab.
                      </div>
                    )}
                  </div>
                </div>

                {/* Panel 2: Highly Political & Toxic Blacklist */}
                <div className="bg-[#121212] border border-[#2A2A2A] rounded-xl p-5 flex flex-col gap-4">
                  <div className="flex items-center justify-between border-b border-[#2A2A2A] pb-3">
                    <h3 className="font-serif text-red-400 text-sm uppercase tracking-widest flex items-center gap-2">
                      <Flame className="w-4 h-4 text-red-400" />
                      Toxic Politics & Stress Blacklist
                    </h3>
                    <span className="text-[9px] font-mono bg-red-400/10 border border-red-400/30 text-red-400 px-2 py-0.5 rounded uppercase">
                      Stress &gt;= 60
                    </span>
                  </div>

                  <div className="flex flex-col gap-4">
                    {analytics.toxicBlacklist.length > 0 ? (
                      analytics.toxicBlacklist.map((co, cIdx) => (
                        <div key={cIdx} className="bg-[#161616] border border-[#2A2A2A] p-4 rounded-lg flex flex-col gap-3 hover:border-red-400/30 transition">
                          <div className="flex justify-between items-start">
                            <div>
                              <h4 className="font-serif text-white font-medium text-sm tracking-wide">{co.company}</h4>
                              <p className="text-[#888] text-[10px] uppercase tracking-wider mt-0.5">{co.industry}</p>
                            </div>
                            <div className="text-right">
                              <span className="text-[10px] text-[#888] uppercase block font-mono">Politics Stress score</span>
                              <span className="text-xl font-serif font-bold text-red-400">{co.politics_stress_score}%</span>
                            </div>
                          </div>

                          {/* Dynamic Meters */}
                          <div className="space-y-2 mt-1">
                            <div>
                              <div className="flex justify-between text-[9px] uppercase tracking-wider text-[#666] mb-1 font-mono">
                                <span>Sensory Overload Index (Open Offices/Storytelling)</span>
                                <span className="text-[#AAA]">{co.sensory_overload_index}%</span>
                              </div>
                              <div className="h-1 bg-black rounded-full overflow-hidden">
                                <div className="h-full bg-red-400" style={{ width: `${co.sensory_overload_index}%` }} />
                              </div>
                            </div>
                            <div>
                              <div className="flex justify-between text-[9px] uppercase tracking-wider text-[#666] mb-1 font-mono">
                                <span>Neurodivergent Compatibility Index</span>
                                <span className="text-[#AAA]">{co.nd_friendly_score}%</span>
                              </div>
                              <div className="h-1 bg-black rounded-full overflow-hidden">
                                <div className="h-full bg-rose-950" style={{ width: `${co.nd_friendly_score}%` }} />
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center justify-between border-t border-[#2A2A2A] pt-3 text-[11px] font-mono mt-1">
                            <span className="text-[#666]">Evaluations: {co.jobs_count} JDs</span>
                            <a
                              href={co.careers_portal_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-red-400 hover:underline flex items-center gap-1"
                            >
                              Verify careers portal <ChevronRight className="w-3 h-3" />
                            </a>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-12 text-[#555] text-xs uppercase tracking-wider font-mono">
                        No highly political or toxic blacklisted environments evaluated yet.
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Elegant minimalist footer */}
      <footer className="border-t border-[#2A2A2A] bg-[#0F0F0F] py-8 text-center text-xs text-[#666]" id="app_footer">
        <p className="uppercase tracking-[0.2em] text-[10px]">© 2026 Job Decision Engine • Created for Elena Okhonko • Cloud Native Deployment Workspace</p>
      </footer>
    </div>
  );
}
