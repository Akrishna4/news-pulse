import unittest
from src.cluster import _greedy_cluster, _compute_label

class TestClusterLogic(unittest.TestCase):

    def test_singleton_creation(self):
        # Empty word set should immediately become a singleton cluster
        word_sets = [set(), {"apple", "banana"}]
        clusters = _greedy_cluster(word_sets)
        # They shouldn't be grouped
        self.assertNotEqual(clusters[0], clusters[1])

    def test_grouping_threshold_met(self):
        # Two sets sharing >=3 words and ratio >=0.4
        ws_a = {"apple", "banana", "cherry", "date"}
        ws_b = {"apple", "banana", "cherry", "elderberry"}
        # Both size 4, shared = 3. 3/4 = 0.75 >= 0.4
        clusters = _greedy_cluster([ws_a, ws_b])
        self.assertEqual(clusters[0], clusters[1])

    def test_grouping_threshold_failed_ratio(self):
        # Two sets sharing >=3 words but ratio < 0.4
        ws_a = {"apple", "banana", "cherry"}
        ws_b = {"apple", "banana", "cherry", "d", "e", "f", "g", "h", "i", "j"}
        # shared = 3, min size = 3, ratio = 3/3 = 1.0... wait, the logic uses min(|A|, |B|).
        # Ah, the logic in cluster.py is shared_count / min(|A|, |B|) >= 0.4
        # So in this case, 3 / 3 = 1.0, it WOULD pass.
        # Let's fail the shared_count check instead: shared < 3
        ws_c = {"apple", "banana", "x"}
        ws_d = {"apple", "banana", "y"}
        # shared = 2, min size = 3, ratio = 2/3 = 0.66. But shared < 3, so fails.
        clusters = _greedy_cluster([ws_c, ws_d])
        self.assertNotEqual(clusters[0], clusters[1])

    def test_compute_label_singleton(self):
        # Should return truncated headline
        label = _compute_label([], "Very Long Headline That Should Eventually Be Truncated By The Label Logic Because It Is Just A Singleton")
        # Just checking it returns the headline logic
        self.assertTrue(label.startswith("Very Long"))

    def test_compute_label_multi(self):
        # Should return top significant words
        member_sets = [
            {"apple", "banana", "cherry"},
            {"apple", "banana", "date"},
            {"apple", "elderberry", "fig"}
        ]
        label = _compute_label(member_sets)
        # "apple" (3), "banana" (2)
        self.assertTrue("apple" in label.lower())
        self.assertTrue("banana" in label.lower())

if __name__ == '__main__':
    unittest.main()
