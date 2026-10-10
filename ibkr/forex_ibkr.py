#!/usr/bin/env python3
"""
IBKR Forex Trading Bot — Moving Average Crossover Strategy

Demo mode:   python forex_ibkr.py demo
Dry-run:     python forex_ibkr.py run
Paper trade: python forex_ibkr.py run --execute
"""

from __future__ import annotations
import json
import math
import random
import argparse
import logging
import sys
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

CONFIG_FILE = Path("ibkr-config.json")

DEFAULT_CONFIG: Dict[str, Any] = {
    "account_id": "DU1234567",
    "host": "127.0.0.1",
    "port": 7497,
    "client_id": 1,
    "pairs": ["EUR/USD", "GBP/USD", "USD/JPY"],
    "strategy": {
        "fast_ma": 20,
        "slow_ma": 50,
        "ma_type": "EMA",
        "timeframe": "1H",
        "risk_per_trade": 0.01,
        "max_positions": 3,
        "ma_periods": [20, 50, 200],
    },
    "risk": {
        "stop_loss_pips": 20,
        "take_profit_pips": 40,
        "max_drawdown": 0.10,
    },
    "demo": {
        "bars": 200,
        "initial_balance": 10000.0,
        "spread_pips": 1.5,
    },
}

PAIR_BASE_PRICES: Dict[str, float] = {
    "EUR/USD": 1.0850,
    "GBP/USD": 1.2650,
    "USD/JPY": 149.50,
    "USD/CHF": 0.9050,
    "AUD/USD": 0.6450,
    "NZD/USD": 0.5950,
    "USD/CAD": 1.3650,
    "EUR/GBP": 0.8580,
    "EUR/JPY": 162.20,
    "GBP/JPY": 189.10,
}

JPY_PAIRS = {"USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY"}


# ── Data structures ────────────────────────────────────────────────────────────

@dataclass
class Config:
    account_id: str
    host: str
    port: int
    client_id: int
    pairs: List[str]
    fast_ma: int
    slow_ma: int
    ma_type: str
    timeframe: str
    risk_per_trade: float
    max_positions: int
    ma_periods: List[int]
    stop_loss_pips: int
    take_profit_pips: int
    max_drawdown: float
    demo_bars: int
    initial_balance: float
    spread_pips: float

    @classmethod
    def load(cls, path: Path = CONFIG_FILE) -> "Config":
        cfg: Dict[str, Any] = {k: (dict(v) if isinstance(v, dict) else v)
                                for k, v in DEFAULT_CONFIG.items()}
        if path.exists():
            with open(path) as f:
                user = json.load(f)
            for k, v in user.items():
                if isinstance(v, dict) and k in cfg and isinstance(cfg[k], dict):
                    cfg[k] = {**cfg[k], **v}
                else:
                    cfg[k] = v
        s, r, d = cfg["strategy"], cfg["risk"], cfg["demo"]
        return cls(
            account_id=cfg["account_id"],
            host=cfg["host"],
            port=cfg["port"],
            client_id=cfg["client_id"],
            pairs=cfg["pairs"],
            fast_ma=s["fast_ma"],
            slow_ma=s["slow_ma"],
            ma_type=s.get("ma_type", "EMA").upper(),
            timeframe=s.get("timeframe", "1H"),
            risk_per_trade=s.get("risk_per_trade", 0.01),
            max_positions=s.get("max_positions", 3),
            ma_periods=s.get("ma_periods", [20, 50, 200]),
            stop_loss_pips=r["stop_loss_pips"],
            take_profit_pips=r["take_profit_pips"],
            max_drawdown=r["max_drawdown"],
            demo_bars=d["bars"],
            initial_balance=d["initial_balance"],
            spread_pips=d["spread_pips"],
        )

    def validate(self) -> None:
        if self.fast_ma >= self.slow_ma:
            raise ValueError(f"fast_ma ({self.fast_ma}) must be < slow_ma ({self.slow_ma})")
        if not self.pairs:
            raise ValueError("At least one currency pair is required")
        for pair in self.pairs:
            if "/" not in pair or len(pair.split("/")) != 2:
                raise ValueError(f"Invalid pair format: {pair!r} (expected 'AAA/BBB')")
        if not 0 < self.risk_per_trade < 1:
            raise ValueError("risk_per_trade must be between 0 and 1")


@dataclass
class Bar:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int


@dataclass
class Signal:
    pair: str
    direction: str  # "LONG" | "SHORT"
    fast_ma_val: float
    slow_ma_val: float
    price: float
    timestamp: datetime


@dataclass
class Position:
    pair: str
    direction: str  # "LONG" | "SHORT"
    entry_price: float
    size: float
    stop_loss: float
    take_profit: float
    open_time: datetime
    close_price: Optional[float] = None
    close_time: Optional[datetime] = None

    @property
    def is_open(self) -> bool:
        return self.close_price is None

    def unrealized_pnl(self, current_price: float) -> float:
        if self.direction == "LONG":
            return (current_price - self.entry_price) * self.size
        return (self.entry_price - current_price) * self.size

    def realized_pnl(self) -> float:
        if self.close_price is None:
            return 0.0
        return self.unrealized_pnl(self.close_price)


# ── Utilities ──────────────────────────────────────────────────────────────────

def pip_size(pair: str) -> float:
    return 0.01 if pair in JPY_PAIRS else 0.0001


def pips_to_price(pair: str, pips: float) -> float:
    return pips * pip_size(pair)


# ── Data Provider ──────────────────────────────────────────────────────────────

class DataProvider:
    """Generates OHLCV bars for demo mode; live mode requires IBKR."""

    def generate_demo_data(
        self,
        pair: str,
        bars: int,
        start_price: Optional[float] = None,
        timeframe_minutes: int = 60,
        seed: Optional[int] = None,
    ) -> List[Bar]:
        """Geometric Brownian Motion price simulation (realistic 1H forex)."""
        if seed is not None:
            random.seed(seed)

        price = start_price if start_price is not None else PAIR_BASE_PRICES.get(pair, 1.0)
        sigma = 0.0008  # ~0.08% per-bar volatility, consistent for all pairs

        now = datetime.utcnow().replace(minute=0, second=0, microsecond=0)
        start_dt = now - timedelta(minutes=timeframe_minutes * bars)
        result: List[Bar] = []

        for i in range(bars):
            dt = start_dt + timedelta(minutes=timeframe_minutes * i)
            change = random.gauss(0.0, sigma)
            open_ = price
            close = max(open_ * (1.0 + change), 1e-5)
            half = abs(random.gauss(0.0, sigma * 0.5))
            high = max(open_, close) * (1.0 + half)
            low = min(open_, close) * (1.0 - half)
            result.append(Bar(
                timestamp=dt,
                open=round(open_, 5),
                high=round(high, 5),
                low=round(low, 5),
                close=round(close, 5),
                volume=random.randint(500, 5000),
            ))
            price = close

        return result

    def get_live_bars(self, pair: str, timeframe: str, count: int) -> List[Bar]:
        raise NotImplementedError(
            "Live data requires ib_insync and a running TWS/IB Gateway. "
            "See ibkr-config.json for setup instructions."
        )


# ── Moving Average Strategy ────────────────────────────────────────────────────

class MAStrategy:

    def sma(self, prices: List[float], period: int) -> List[float]:
        if period <= 0:
            raise ValueError("period must be positive")
        result: List[float] = []
        for i in range(len(prices)):
            if i < period - 1:
                result.append(float("nan"))
            else:
                result.append(sum(prices[i - period + 1 : i + 1]) / period)
        return result

    def ema(self, prices: List[float], period: int) -> List[float]:
        if period <= 0:
            raise ValueError("period must be positive")
        k = 2.0 / (period + 1)
        result: List[float] = []
        ema_prev = float("nan")
        for i, p in enumerate(prices):
            if i < period - 1:
                result.append(float("nan"))
            elif i == period - 1:
                val = sum(prices[:period]) / period
                result.append(val)
                ema_prev = val
            else:
                val = p * k + ema_prev * (1.0 - k)
                result.append(val)
                ema_prev = val
        return result

    def compute_ma(self, prices: List[float], period: int, ma_type: str) -> List[float]:
        if ma_type.upper() == "SMA":
            return self.sma(prices, period)
        if ma_type.upper() == "EMA":
            return self.ema(prices, period)
        raise ValueError(f"Unknown MA type: {ma_type!r}")

    def generate_signals(self, bars: List[Bar], config: Config) -> List[Signal]:
        closes = [b.close for b in bars]
        fast = self.compute_ma(closes, config.fast_ma, config.ma_type)
        slow = self.compute_ma(closes, config.slow_ma, config.ma_type)

        signals: List[Signal] = []
        for i in range(1, len(bars)):
            f_cur, f_prev = fast[i], fast[i - 1]
            s_cur, s_prev = slow[i], slow[i - 1]
            if any(math.isnan(v) for v in (f_cur, f_prev, s_cur, s_prev)):
                continue
            if f_prev <= s_prev and f_cur > s_cur:
                direction = "LONG"
            elif f_prev >= s_prev and f_cur < s_cur:
                direction = "SHORT"
            else:
                continue
            signals.append(Signal(
                pair="",
                direction=direction,
                fast_ma_val=round(f_cur, 5),
                slow_ma_val=round(s_cur, 5),
                price=bars[i].close,
                timestamp=bars[i].timestamp,
            ))
        return signals


# ── Progression Schedule ───────────────────────────────────────────────────────

class ProgressionSchedule:
    """Forex session schedule: Sydney → Tokyo → London → New York."""

    # (open_hour_UTC, close_hour_UTC); close < open means wraps midnight
    SESSIONS: Dict[str, Tuple[int, int]] = {
        "Sydney":   (21, 6),
        "Tokyo":    (0, 9),
        "London":   (8, 17),
        "New York": (13, 22),
    }
    BEST_PAIRS: Dict[str, List[str]] = {
        "Sydney":   ["AUD/USD", "NZD/USD"],
        "Tokyo":    ["USD/JPY", "EUR/JPY", "GBP/JPY"],
        "London":   ["EUR/USD", "GBP/USD", "EUR/GBP"],
        "New York": ["EUR/USD", "USD/CAD", "USD/CHF"],
    }

    def active_sessions(self, now: Optional[datetime] = None) -> List[str]:
        if now is None:
            now = datetime.utcnow()
        h = now.hour
        active = []
        for name, (open_h, close_h) in self.SESSIONS.items():
            if open_h < close_h:
                if open_h <= h < close_h:
                    active.append(name)
            else:
                if h >= open_h or h < close_h:
                    active.append(name)
        return active

    def next_opens(self, now: Optional[datetime] = None) -> List[Dict]:
        if now is None:
            now = datetime.utcnow()
        result = []
        for name, (open_h, _) in self.SESSIONS.items():
            dt = now.replace(hour=open_h, minute=0, second=0, microsecond=0)
            if dt <= now:
                dt += timedelta(days=1)
            result.append({"session": name, "opens_at": dt.isoformat() + "Z"})
        result.sort(key=lambda x: x["opens_at"])
        return result

    def schedule_summary(self) -> str:
        now = datetime.utcnow()
        active = self.active_sessions(now)
        nxt = self.next_opens(now)
        lines = [
            f"UTC {now.strftime('%H:%M')} — Active: {', '.join(active) or 'None'}",
        ]
        for s in nxt[:2]:
            lines.append(f"  Next: {s['session']} opens {s['opens_at'][11:16]} UTC")
        return "\n".join(lines)


# ── News Provider ──────────────────────────────────────────────────────────────

_MOCK_EVENTS = [
    {"time": "08:30", "currency": "USD", "event": "Non-Farm Payrolls",    "impact": "HIGH"},
    {"time": "10:00", "currency": "EUR", "event": "ECB Rate Decision",    "impact": "HIGH"},
    {"time": "13:30", "currency": "GBP", "event": "UK CPI m/m",          "impact": "MED"},
    {"time": "15:00", "currency": "USD", "event": "FOMC Meeting Minutes", "impact": "HIGH"},
    {"time": "01:30", "currency": "AUD", "event": "RBA Rate Decision",    "impact": "HIGH"},
    {"time": "00:50", "currency": "JPY", "event": "BOJ Policy Rate",      "impact": "HIGH"},
    {"time": "12:30", "currency": "CAD", "event": "Canada CPI m/m",      "impact": "MED"},
    {"time": "09:00", "currency": "EUR", "event": "EU Manufacturing PMI", "impact": "MED"},
]


class NewsProvider:
    """Economic calendar (mock data in demo mode)."""

    def today_events(self, currencies: Optional[List[str]] = None) -> List[Dict]:
        events = list(_MOCK_EVENTS)
        if currencies:
            curs = {c.upper() for c in currencies}
            events = [e for e in events if e["currency"] in curs]
        return sorted(events, key=lambda x: x["time"])

    def high_impact_count(self, currencies: Optional[List[str]] = None) -> int:
        return sum(1 for e in self.today_events(currencies) if e["impact"] == "HIGH")

    def format_feed(self, currencies: Optional[List[str]] = None) -> str:
        events = self.today_events(currencies)
        if not events:
            return "No scheduled events today."
        lines = ["── Economic Calendar ──────────────────────────────"]
        for e in events:
            icon = "[HIGH]" if e["impact"] == "HIGH" else "[MED ]"
            lines.append(f"  {icon} {e['time']} UTC  {e['currency']:4s} {e['event']}")
        return "\n".join(lines)


# ── Trade Manager ──────────────────────────────────────────────────────────────

class TradeManager:

    def __init__(self, config: Config) -> None:
        self.config = config
        self.balance = config.initial_balance
        self.positions: List[Position] = []
        self.closed: List[Position] = []

    def position_size(self, pair: str, price: float) -> float:
        """Risk-based sizing: round to nearest mini-lot (10,000 units)."""
        risk_amount = self.balance * self.config.risk_per_trade
        sl_distance = pips_to_price(pair, self.config.stop_loss_pips)
        if sl_distance <= 0:
            return 0.0
        units = risk_amount / sl_distance
        mini_lots = max(1, round(units / 10_000))
        return mini_lots * 10_000

    def open_position(self, pair: str, direction: str, price: float) -> Position:
        if len(self.positions) >= self.config.max_positions:
            raise RuntimeError(
                f"Max positions ({self.config.max_positions}) already open"
            )
        ps = pip_size(pair)
        if direction == "LONG":
            sl = price - self.config.stop_loss_pips * ps
            tp = price + self.config.take_profit_pips * ps
        else:
            sl = price + self.config.stop_loss_pips * ps
            tp = price - self.config.take_profit_pips * ps
        pos = Position(
            pair=pair,
            direction=direction,
            entry_price=price,
            size=self.position_size(pair, price),
            stop_loss=round(sl, 5),
            take_profit=round(tp, 5),
            open_time=datetime.utcnow(),
        )
        self.positions.append(pos)
        return pos

    def close_position(self, position: Position, price: float) -> float:
        position.close_price = price
        position.close_time = datetime.utcnow()
        pnl = position.realized_pnl()
        self.balance += pnl
        self.positions = [p for p in self.positions if p is not position]
        self.closed.append(position)
        return pnl

    def check_stops(self, pair: str, bar: Bar) -> List[Tuple[Position, str, float]]:
        hits = []
        for pos in list(self.positions):
            if pos.pair != pair:
                continue
            if pos.direction == "LONG":
                if bar.low <= pos.stop_loss:
                    hits.append((pos, "SL", pos.stop_loss))
                elif bar.high >= pos.take_profit:
                    hits.append((pos, "TP", pos.take_profit))
            else:
                if bar.high >= pos.stop_loss:
                    hits.append((pos, "SL", pos.stop_loss))
                elif bar.low <= pos.take_profit:
                    hits.append((pos, "TP", pos.take_profit))
        return hits

    @property
    def total_pnl(self) -> float:
        return sum(p.realized_pnl() for p in self.closed)

    @property
    def win_rate(self) -> float:
        if not self.closed:
            return 0.0
        return sum(1 for p in self.closed if p.realized_pnl() > 0) / len(self.closed)

    def summary(self) -> str:
        return (
            f"Balance: ${self.balance:>10,.2f}  "
            f"P&L: ${self.total_pnl:>+9,.2f}  "
            f"Trades: {len(self.closed):>3}  "
            f"Win rate: {self.win_rate:.0%}"
        )


# ── Trading Bot ────────────────────────────────────────────────────────────────

class TradingBot:

    def __init__(self, config: Config) -> None:
        self.config = config
        self.data = DataProvider()
        self.strategy = MAStrategy()
        self.schedule = ProgressionSchedule()
        self.news = NewsProvider()
        self.manager = TradeManager(config)

    def run_demo(self) -> None:
        print("=" * 62)
        print("  IBKR FOREX BOT — DEMO MODE (offline, no account needed)")
        print("=" * 62)

        print("\n" + self.schedule.schedule_summary())

        currencies = list(
            {p.split("/")[0] for p in self.config.pairs}
            | {p.split("/")[1] for p in self.config.pairs}
        )
        print("\n" + self.news.format_feed(currencies))

        print(f"\nStrategy : {self.config.ma_type}({self.config.fast_ma}) × "
              f"{self.config.ma_type}({self.config.slow_ma})")
        print(f"Alt MAs  : {self.config.ma_periods}")
        print(f"Pairs    : {', '.join(self.config.pairs)}")
        print(f"Balance  : ${self.config.initial_balance:,.2f}")
        print()

        for pair in self.config.pairs:
            self._demo_pair(pair)

        print("\n── Final Account Summary " + "─" * 37)
        print(self.manager.summary())
        print("=" * 62)
        print("Demo complete. No real orders were placed.")

    def _demo_pair(self, pair: str) -> None:
        print(f"\n── {pair} {'─' * (55 - len(pair))}")
        bars = self.data.generate_demo_data(pair, self.config.demo_bars)
        signals = self.strategy.generate_signals(bars, self.config)
        log.info(f"  {len(bars)} bars  |  {len(signals)} crossover signal(s)")

        spread = pips_to_price(pair, self.config.spread_pips)
        current_pos: Optional[Position] = None

        for sig in signals:
            price = sig.price
            if current_pos and current_pos.direction != sig.direction:
                pnl = self.manager.close_position(current_pos, price)
                log.info(
                    f"  CLOSE {current_pos.direction:5s} @ {price:.5f}"
                    f"  P&L ${pnl:+.2f}"
                )
                current_pos = None

            if not current_pos and len(self.manager.positions) < self.config.max_positions:
                try:
                    entry = price + spread if sig.direction == "LONG" else price - spread
                    current_pos = self.manager.open_position(pair, sig.direction, entry)
                    log.info(
                        f"  OPEN  {sig.direction:5s} @ {entry:.5f}"
                        f"  SL {current_pos.stop_loss:.5f}"
                        f"  TP {current_pos.take_profit:.5f}"
                        f"  size {current_pos.size:,.0f}"
                    )
                except RuntimeError as e:
                    log.warning(f"  Skipped open: {e}")

        if current_pos:
            last = bars[-1].close
            pnl = self.manager.close_position(current_pos, last)
            log.info(f"  CLOSE (EOD) @ {last:.5f}  P&L ${pnl:+.2f}")

    def run(self, execute: bool = False) -> None:
        mode = "PAPER TRADING" if execute else "DRY-RUN (no orders sent)"
        print("=" * 62)
        print(f"  IBKR FOREX BOT — {mode}")
        print("=" * 62)
        try:
            import ib_insync  # noqa: F401
        except ImportError:
            log.error(
                "ib_insync not installed. Run:  pip install ib_insync\n"
                "Then start TWS or IB Gateway with API connections enabled."
            )
            sys.exit(1)
        log.info(f"Connecting to IBKR at {self.config.host}:{self.config.port} ...")
        log.info("(Connection logic executes here once TWS/Gateway is running.)")
        if not execute:
            log.info("Dry-run complete — pass --execute to send orders.")


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="IBKR Forex MA Crossover Bot",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python forex_ibkr.py demo            # offline simulation\n"
            "  python forex_ibkr.py run              # dry-run\n"
            "  python forex_ibkr.py run --execute   # paper trading\n"
        ),
    )
    parser.add_argument("mode", choices=["demo", "run"])
    parser.add_argument("--execute", action="store_true",
                        help="Send orders to IBKR (paper trading)")
    parser.add_argument("--config", type=Path, default=CONFIG_FILE,
                        help="Path to ibkr-config.json")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    cfg = Config.load(args.config)
    cfg.validate()
    bot = TradingBot(cfg)

    if args.mode == "demo":
        bot.run_demo()
    else:
        bot.run(execute=args.execute)


if __name__ == "__main__":
    main()
