from pipeline.models import User


def main():
    # balk2: confidence=low app.py:main calls pipeline/util.py:helper
    return User().save()
