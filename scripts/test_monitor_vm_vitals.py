#!/usr/bin/env python3
import logging
from pathlib import Path
import tempfile
import unittest

from monitor_vm_vitals import cpu_rates, log_handler


class GuestAccounting(unittest.TestCase):
    def test_steal_and_iowait_do_not_count_as_work(self):
        before = [100, 0, 20, 200, 10, 0, 0, 5]
        after = [120, 0, 30, 250, 20, 0, 0, 15]
        self.assertEqual(cpu_rates(before, after), {
            'work_pct': 30.0, 'idle_pct': 50.0, 'iowait_pct': 10.0, 'steal_pct': 10.0,
        })

    def test_reset_or_empty_interval_is_not_fake_zero_contention(self):
        baseline = [100, 0, 20, 200, 10, 0, 0, 5]
        self.assertIsNone(cpu_rates(baseline, baseline))
        self.assertIsNone(cpu_rates(baseline, [0] * 8))

    def test_rotation_bounds_storage_and_keeps_latest_complete_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'samples.jsonl'
            logger = logging.Logger('retention')
            handler = log_handler(path, max_bytes=128, backups=2)
            logger.addHandler(handler)
            try:
                for index in range(30):
                    logger.info('{"sample":%d,"state":"cpu-pressure-sample"}', index)
            finally:
                handler.close()
            files = list(Path(directory).iterdir())
            self.assertLessEqual(len(files), 3)
            self.assertLessEqual(sum(file.stat().st_size for file in files), 3 * 128)
            self.assertEqual(path.read_text().splitlines()[-1], '{"sample":29,"state":"cpu-pressure-sample"}')


if __name__ == '__main__':
    unittest.main()
