from pipeline.util import Base, helper


class User(Base):
    def save(self):
        return helper(self.describe())
