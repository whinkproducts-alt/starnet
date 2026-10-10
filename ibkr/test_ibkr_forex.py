#!/usr/bin/env python3
"""
IBKR Forex Bot — full test suite (20 tests)
Run: python -m unittest test_ibkr_forex.py -v
"""

import json
import math
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from forex_ibkr import (
    Config,
    Bar,
    Position,
    DataProvider,
    MAStrategy,
    TradeManager,
    ProgressionSchedule,
    NewsProvider,
    pip_size,
    pips_to_price,
    DEFAULT_CONFIG,
)


def _cfg(**overrides) -> Config:
    """Return a default Config with optional field overrides."""
    cfg = Config.load(Path("/nonexistent_xyz.json"))
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return cfg


def _flat_bars(price: float = 1.085, n: int = 60) -> list:
    now = datetime.utcnow()
    return [Bar(now, price, price, price, price, 1000) for _ in range(n)]


def _trend_bars(start: float, step: float, n: int = 100) -> list:
    now = datetime.utcnow()
    bars = []
    p = start
    for _ in range(n):
        p = max(p + step, 1e-5)
        bars.append(Bar(now, p, p * 1.001, p * 0.999, p, 1000))
    return bars


# ══ Config ════════════════════════════════════════════════════════════════════

class TestConfig(unittest.TestCase):

    def test_01_loads_defaults_when_file_missing(self):
        cfg = Config.load(Path("/nonexistent_xyz.json"))
        self.assertEqual(cfg.fast_ma, DEFAULT_CONFIG["strategy"]["fast_ma"])
        self.assertEqual(cfg.slow_ma, DEFAULT_CONFIG["strategy"]["slow_ma"])
        self.assertEqual(cfg.initial_balance, DEFAULT_CONFIG["demo"]["initial_balance"])

    def test_02_merges_user_file_over_defaults(self):
        user = {"account_id": "U9999999", "strategy": {"fast_ma": 10, "slow_ma": 30}}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(user, f)
            path = Path(f.name)
        cfg = Config.load(path)
        path.unlink()
        self.assertEqual(cfg.account_id, "U9999999")
        self.assertEqual(cfg.fast_ma, 10)
        self.assertEqual(cfg.slow_ma, 30)
        # default fields preserved
        self.assertEqual(cfg.stop_loss_pips, DEFAULT_CONFIG["risk"]["stop_loss_pips"])

    def test_03_validate_raises_when_fast_ge_slow(self):
        with self.assertRaises(ValueError):
            _cfg(fast_ma=50, slow_ma=20).validate()

    def test_04_validate_raises_on_bad_pair_format(self):
        with self.assertRaises(ValueError):
            _cfg(pairs=["EURUSD"]).validate()  # missing slash

    def test_05_validate_raises_on_bad_risk(self):
        with self.assertRaises(ValueError):
            _cfg(risk_per_trade=1.5).validate()


# ══ Moving Averages ═══════════════════════════════════════════════════════════

class TestMACalc(unittest.TestCase):

    def setUp(self):
        self.strat = MAStrategy()
        self.prices = [float(i) for i in range(1, 21)]  # 1..20

    def test_06_sma_correct_value(self):
        result = self.strat.sma([1.0, 2.0, 3.0, 4.0, 5.0], 5)
        self.assertAlmostEqual(result[-1], 3.0)

    def test_07_sma_leading_nans(self):
        result = self.strat.sma(self.prices, 5)
        for v in result[:4]:
            self.assertTrue(math.isnan(v), f"Expected NaN, got {v}")
        self.assertFalse(math.isnan(result[4]))

    def test_08_ema_flat_series_equals_price(self):
        prices = [10.0] * 20
        result = self.strat.ema(prices, 3)
        for v in result[2:]:
            self.assertAlmostEqual(v, 10.0, places=5)

    def test_09_ema_length_matches_input(self):
        result = self.strat.ema(self.prices, 5)
        self.assertEqual(len(result), len(self.prices))


# ══ Signals ═══════════════════════════════════════════════════════════════════

class TestSignals(unittest.TestCase):

    def setUp(self):
        self.strat = MAStrategy()
        # fast=5, slow=10 for quick crossovers on short series
        self.cfg5_10 = _cfg(fast_ma=5, slow_ma=10, ma_type="SMA")

    def test_10_bullish_crossover_produces_long_signal(self):
        # Fall first so fast MA drops below slow MA, then sharp rise triggers LONG cross
        downtrend = _trend_bars(100.0, -0.50, 50)
        uptrend   = _trend_bars(downtrend[-1].close, +1.50, 50)
        bars = downtrend + uptrend
        sigs = self.strat.generate_signals(bars, self.cfg5_10)
        self.assertTrue(any(s.direction == "LONG" for s in sigs),
                        "Expected at least one LONG signal")

    def test_11_bearish_crossover_produces_short_signal(self):
        # Rise first so fast MA climbs above slow MA, then sharp fall triggers SHORT cross
        uptrend   = _trend_bars(100.0, +0.50, 50)
        downtrend = _trend_bars(uptrend[-1].close, -1.50, 50)
        bars = uptrend + downtrend
        sigs = self.strat.generate_signals(bars, self.cfg5_10)
        self.assertTrue(any(s.direction == "SHORT" for s in sigs),
                        "Expected at least one SHORT signal")

    def test_12_flat_prices_produce_no_signal(self):
        bars = _flat_bars(1.085, 60)
        sigs = self.strat.generate_signals(bars, self.cfg5_10)
        self.assertEqual(len(sigs), 0)


# ══ Demo Data ═════════════════════════════════════════════════════════════════

class TestDemoData(unittest.TestCase):

    def setUp(self):
        self.dp = DataProvider()

    def test_13_demo_data_correct_length(self):
        bars = self.dp.generate_demo_data("EUR/USD", 100)
        self.assertEqual(len(bars), 100)

    def test_14_bar_ohlc_invariant(self):
        bars = self.dp.generate_demo_data("EUR/USD", 80, seed=42)
        for b in bars:
            self.assertGreater(b.open, 0,  "open must be > 0")
            self.assertGreater(b.close, 0, "close must be > 0")
            self.assertGreaterEqual(b.high, b.close, "high >= close")
            self.assertLessEqual(b.low, b.close,    "low <= close")
            self.assertGreater(b.volume, 0,          "volume must be > 0")

    def test_15_jpy_price_in_realistic_range(self):
        bars = self.dp.generate_demo_data("USD/JPY", 50, seed=0)
        for b in bars:
            self.assertGreater(b.close, 50,  "USD/JPY below 50 is unrealistic")
            self.assertLess(b.close, 300,    "USD/JPY above 300 is unrealistic")


# ══ Trade Manager ═════════════════════════════════════════════════════════════

class TestTradeManager(unittest.TestCase):

    def setUp(self):
        self.cfg = _cfg(
            initial_balance=10_000.0,
            risk_per_trade=0.01,
            stop_loss_pips=20,
            take_profit_pips=40,
            max_positions=3,
        )
        self.mgr = TradeManager(self.cfg)

    def test_16_open_long_sets_sl_tp_correctly(self):
        pos = self.mgr.open_position("EUR/USD", "LONG", 1.0850)
        self.assertEqual(pos.direction, "LONG")
        expected_sl = round(1.0850 - 20 * 0.0001, 5)
        expected_tp = round(1.0850 + 40 * 0.0001, 5)
        self.assertAlmostEqual(pos.stop_loss,   expected_sl, places=4)
        self.assertAlmostEqual(pos.take_profit, expected_tp, places=4)

    def test_17_close_winning_long_increases_balance(self):
        pos = self.mgr.open_position("EUR/USD", "LONG", 1.0850)
        before = self.mgr.balance
        pnl = self.mgr.close_position(pos, 1.0900)  # +50 pips
        self.assertGreater(pnl, 0, "50-pip win must be positive P&L")
        self.assertAlmostEqual(self.mgr.balance, before + pnl)

    def test_18_short_trade_down_has_positive_pnl(self):
        pos = self.mgr.open_position("EUR/USD", "SHORT", 1.0850)
        pnl = pos.unrealized_pnl(1.0800)  # price fell 50 pips
        self.assertGreater(pnl, 0)

    def test_19_max_positions_raises_on_overflow(self):
        cfg = _cfg(max_positions=1)
        mgr = TradeManager(cfg)
        mgr.open_position("EUR/USD", "LONG", 1.0850)
        with self.assertRaises(RuntimeError):
            mgr.open_position("GBP/USD", "LONG", 1.2650)


# ══ Schedule + News ═══════════════════════════════════════════════════════════

class TestScheduleAndNews(unittest.TestCase):

    def test_20_schedule_returns_sessions_and_next_opens(self):
        sched = ProgressionSchedule()
        active = sched.active_sessions()
        self.assertIsInstance(active, list)
        for s in active:
            self.assertIn(s, sched.SESSIONS)

        nxt = sched.next_opens()
        self.assertEqual(len(nxt), len(sched.SESSIONS))
        self.assertIn("session",  nxt[0])
        self.assertIn("opens_at", nxt[0])

        # Bonus: news provider returns events with required keys
        news = NewsProvider()
        events = news.today_events()
        self.assertGreater(len(events), 0)
        for e in events:
            for key in ("time", "currency", "event", "impact"):
                self.assertIn(key, e)


if __name__ == "__main__":
    unittest.main(verbosity=2)
