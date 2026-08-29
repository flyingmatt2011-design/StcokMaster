from copy import deepcopy

from src.core.config_registry import get_category_definitions
from src.core.config_registry_categories import CATEGORY_DEFINITIONS


def test_category_extraction_preserves_registry_contract_and_copy_isolation():
    expected = deepcopy(CATEGORY_DEFINITIONS)
    first = get_category_definitions()
    first[0]["title"] = "mutated"

    assert get_category_definitions() == expected
